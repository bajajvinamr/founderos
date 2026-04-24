import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { FounderOSConfig } from "../config/schema.js";
import { expandHomePrefix } from "../config/home.js";
import { readConfig } from "../config/store.js";

export type ConfiguredStorage = {
  getObject(companyId: string, objectKey: string): Promise<Buffer>;
  putObject(companyId: string, objectKey: string, body: Buffer, contentType: string): Promise<void>;
};

export function assertStorageCompanyPrefix(companyId: string, objectKey: string): void {
  if (!objectKey.startsWith(`${companyId}/`) || objectKey.includes("..")) {
    throw new Error(`Invalid object key for company ${companyId}.`);
  }
}

export function normalizeStorageObjectKey(objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw new Error("Invalid object key.");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid object key.");
  }
  return parts.join("/");
}

export function resolveLocalStoragePath(baseDir: string, objectKey: string): string {
  const resolved = path.resolve(baseDir, normalizeStorageObjectKey(objectKey));
  const root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid object key path.");
  }
  return resolved;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error("Object not found.");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Readable) {
    return await streamToBuffer(body);
  }

  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  if (typeof candidate.arrayBuffer === "function") {
    return Buffer.from(await candidate.arrayBuffer());
  }

  throw new Error("Unsupported storage response body.");
}

function normalizeS3Prefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildS3ObjectKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;

export function createConfiguredStorageFromFounderOSConfig(config: FounderOSConfig): ConfiguredStorage {
  if (config.storage.provider === "local_disk") {
    const baseDir = expandHomePrefix(config.storage.localDisk.baseDir);
    return {
      async getObject(companyId: string, objectKey: string) {
        assertStorageCompanyPrefix(companyId, objectKey);
        return await fsPromises.readFile(resolveLocalStoragePath(baseDir, objectKey));
      },
      async putObject(companyId: string, objectKey: string, body: Buffer) {
        assertStorageCompanyPrefix(companyId, objectKey);
        const filePath = resolveLocalStoragePath(baseDir, objectKey);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, body);
      },
    };
  }

  const prefix = normalizeS3Prefix(config.storage.s3.prefix);
  let s3ClientPromise: Promise<any> | null = null;
  async function getS3Client() {
    if (!s3ClientPromise) {
      s3ClientPromise = (async () => {
        const sdk = await dynamicImport("@aws-sdk/client-s3");
        return {
          sdk,
          client: new sdk.S3Client({
            region: config.storage.s3.region,
            endpoint: config.storage.s3.endpoint,
            forcePathStyle: config.storage.s3.forcePathStyle,
          }),
        };
      })();
    }
    return await s3ClientPromise;
  }
  const bucket = config.storage.s3.bucket;
  return {
    async getObject(companyId: string, objectKey: string) {
      assertStorageCompanyPrefix(companyId, objectKey);
      const { sdk, client } = await getS3Client();
      const response = await client.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
        }),
      );
      return await s3BodyToBuffer(response.Body);
    },
    async putObject(companyId: string, objectKey: string, body: Buffer, contentType: string) {
      assertStorageCompanyPrefix(companyId, objectKey);
      const { sdk, client } = await getS3Client();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
    },
  };
}

export function openConfiguredStorage(configPath: string): ConfiguredStorage {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }
  return createConfiguredStorageFromFounderOSConfig(config);
}

export function isMissingStorageObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  return candidate.code === "ENOENT"
    || candidate.status === 404
    || candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.message === "Object not found.";
}

export async function readSourceAttachmentBody(
  sourceStorages: Array<Pick<ConfiguredStorage, "getObject">>,
  companyId: string,
  objectKey: string,
): Promise<Buffer | null> {
  for (const sourceStorage of sourceStorages) {
    try {
      return await sourceStorage.getObject(companyId, objectKey);
    } catch (error) {
      if (isMissingStorageObjectError(error)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}
