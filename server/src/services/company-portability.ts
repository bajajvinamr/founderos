import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@founderos/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExport,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityProjectWorkspaceManifestEntry,
  CompanyPortabilityIssueRoutineManifestEntry,
  CompanyPortabilityIssueRoutineTriggerManifestEntry,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilitySidebarOrder,
  CompanyPortabilitySkillManifestEntry,
  CompanySkill,
  AgentEnvConfig,
  RoutineVariable,
} from "@founderos/shared";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  deriveProjectUrlKey,
  envConfigSchema,
  normalizeAgentUrlKey,
} from "@founderos/shared";
import {
  readFounderOSSkillSyncPreference,
  writeFounderOSSkillSyncPreference,
} from "@founderos/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import { assertSafeGitHubHostname, ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import type { StorageService } from "../storage/types.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { assetService } from "./assets.js";
import { generateReadme } from "./company-export-readme.js";
import { renderOrgChartPng, type OrgNode } from "../routes/org-chart-svg.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";
import { validateCron } from "./cron.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";


export * from "./company-portability-helpers.js";
import {
  ADAPTER_DEFAULT_RULES_BY_TYPE,
  AgentLike,
  appendSkillExportDirSuffix,
  applySelectedFilesToSource,
  asBoolean,
  asInteger,
  asString,
  bufferToPortableBinaryFile,
  buildEnvInputMap,
  buildLegacyRoutineTriggerFromRecurrence,
  buildManifestFromPackageFiles,
  buildMarkdown,
  buildOrgTreeFromManifest,
  buildPortableProjectWorkspaces,
  buildReferencedSkillMarkdown,
  buildRoutineManifestFromLiveRoutine,
  buildSkillExportDirMap,
  buildSkillSourceEntry,
  buildYamlFile,
  classifyPortableFileKind,
  clonePortableRecord,
  collectSelectedExportSlugs,
  COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS,
  COMPANY_LOGO_FILE_NAME,
  CompanyPackageIncludeEntry,
  compareYamlKeys,
  containsAbsolutePathFragment,
  containsSystemDependentPathValue,
  dedupeEnvInputs,
  DEFAULT_COLLISION_STRATEGY,
  DEFAULT_INCLUDE,
  deriveLocalExportNamespace,
  deriveManifestSkillKey,
  derivePortableProjectWorkspaceKey,
  derivePrimarySkillExportDir,
  deriveSkillExportDirCandidates,
  disableImportedTimerHeartbeat,
  ensureMarkdownPath,
  EnvInputRecord,
  execFileAsync,
  exportPortableProjectExecutionWorkspacePolicy,
  extractPortableEnvInputs,
  extractPortableProjectEnvInputs,
  extractPortableScopedEnvInputs,
  fetchBinary,
  fetchJson,
  fetchOptionalText,
  fetchText,
  filterCompanyMarkdownIncludes,
  filterExportFiles,
  filterPortableExtensionYaml,
  findFounderOSExtensionPath,
  FounderOSExtensionDoc,
  hashSkillValue,
  ImportBehaviorOptions,
  ImportMode,
  ImportPlanInternal,
  importPortableProjectExecutionWorkspacePolicy,
  inferContentTypeFromPath,
  inferPortableWorkspaceGitMetadata,
  isAbsoluteCommand,
  isEmptyArray,
  isEmptyObject,
  isPathDefault,
  isPlainRecord,
  isPortableBinaryFile,
  isSensitiveEnvKey,
  IssueLike,
  jsonEqual,
  MarkdownDoc,
  normalizeCronList,
  normalizeExportPathSegment,
  normalizeFileMap,
  normalizeGitHubSourcePath,
  normalizeInclude,
  normalizePortableConfig,
  normalizePortablePath,
  normalizePortableProjectEnv,
  normalizePortableProjectWorkspaceExtension,
  normalizePortableSidebarOrder,
  normalizePortableSlugList,
  normalizeRoutineExtension,
  normalizeRoutineTriggerExtension,
  normalizeRoutineVariableExtension,
  normalizeSelectedFiles,
  normalizeSkillKey,
  normalizeSkillSlug,
  orderedYamlEntries,
  parseFrontmatterMarkdown,
  parseGitHubSourceUrl,
  parseYamlBlock,
  parseYamlFile,
  parseYamlFrontmatter,
  parseYamlScalar,
  pickTextFiles,
  portableBinaryFileToBuffer,
  portableFileToBuffer,
  prepareYamlLines,
  ProjectLike,
  pruneDefaultLikeValue,
  readAgentEnvInputs,
  readAgentSkillRefs,
  readCompanyApprovalDefault,
  readGitOutput,
  readIncludeEntries,
  readPortableTextFile,
  readProjectEnvInputs,
  readSkillKey,
  readSkillSourceKind,
  readZonedDateParts,
  renderFrontmatter,
  renderYamlBlock,
  renderYamlScalar,
  resolveBundledSkillsCommit,
  resolveCompanyLogoExtension,
  ResolvedSource,
  resolveImportMode,
  resolvePortablePath,
  resolvePortableRoutineDefinition,
  resolveSkillConflictStrategy,
  RoutineLike,
  RUNTIME_DEFAULT_RULES,
  shouldReferenceSkillOnExport,
  sortAgentsBySidebarOrder,
  streamToBuffer,
  stripEmptyValues,
  stripPortableProjectExecutionWorkspaceRefs,
  toSafeSlug,
  uniqueNameBySlug,
  uniqueProjectName,
  uniqueSlug,
  WEEKDAY_TO_CRON,
  withSkillSourceMetadata,
  YAML_KEY_PRIORITY,
  YAML_KEY_PRIORITY_INDEX,
} from "./company-portability-helpers.js";

export function companyPortabilityService(db: Db, storage?: StorageService) {
  const companies = companyService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const instructions = agentInstructionsService();
  const access = accessService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const companySkills = companySkillService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(
        normalizeFileMap(source.files, source.rootPath),
      );
    }

    const parsed = parseGitHubSourceUrl(source.url);
    await assertSafeGitHubHostname(parsed.hostname);
    let ref = parsed.ref;
    const warnings: string[] = [];
    const companyRelativePath = parsed.companyPath === "COMPANY.md"
      ? [parsed.basePath, "COMPANY.md"].filter(Boolean).join("/")
      : parsed.companyPath;
    let companyMarkdown: string | null = null;
    try {
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        companyMarkdown = await fetchOptionalText(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
        );
      } else {
        throw err;
      }
    }
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const companyPath = parsed.companyPath === "COMPANY.md"
      ? "COMPANY.md"
      : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
    const files: Record<string, CompanyPortabilityFileEntry> = {
      [companyPath]: companyMarkdown,
    };
    const apiBase = gitHubApiBase(parsed.hostname);
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => ({ tree: [] }));
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const candidatePaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        if (basePrefix && !entry.startsWith(basePrefix)) return false;
        const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
        return (
          relative.endsWith(".md") ||
          relative.startsWith("skills/") ||
          relative === ".founderos.yaml" ||
          relative === ".founderos.yml"
        );
      });
    for (const repoPath of candidatePaths) {
      const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
      if (files[relativePath] !== undefined) continue;
      files[normalizePortablePath(relativePath)] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
    const includeEntries = readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
      const relativePath = normalizePortablePath(includeEntry.path);
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    const companyLogoPath = resolved.manifest.company?.logoPath;
    if (companyLogoPath && !resolved.files[companyLogoPath]) {
      const repoPath = [parsed.basePath, companyLogoPath].filter(Boolean).join("/");
      try {
        const binary = await fetchBinary(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
        );
        resolved.files[companyLogoPath] = bufferToPortableBinaryFile(binary, inferContentTypeFromPath(companyLogoPath));
      } catch (err) {
        warnings.push(`Failed to fetch company logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resolved.warnings.unshift(...warnings);
    return resolved;
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude({
      ...input.include,
      agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
      projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
      issues:
        (input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0)
          ? true
          : input.include?.issues,
      skills: input.skills && input.skills.length > 0 ? true : input.include?.skills,
    });
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, CompanyPortabilityFileEntry> = {};
    const warnings: string[] = [];
    const envInputs: CompanyPortabilityManifest["envInputs"] = [];
    const requestedSidebarOrder = normalizePortableSidebarOrder(input.sidebarOrder);
    const rootPath = normalizeAgentUrlKey(company.name) ?? "company-package";
    let companyLogoPath: string | null = null;

    const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
    const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    const companySkillRows = include.skills || include.agents ? await companySkills.listFull(companyId) : [];
    if (include.agents) {
      const skipped = allAgentRows.length - liveAgentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const agentByReference = new Map<string, typeof liveAgentRows[number]>();
    for (const agent of liveAgentRows) {
      agentByReference.set(agent.id, agent);
      agentByReference.set(agent.name, agent);
      const normalizedName = normalizeAgentUrlKey(agent.name);
      if (normalizedName) {
        agentByReference.set(normalizedName, agent);
      }
    }

    const selectedAgents = new Map<string, typeof liveAgentRows[number]>();
    for (const selector of input.agents ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
      const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
      if (!match) {
        warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedAgents.set(match.id, match);
    }

    if (include.agents && selectedAgents.size === 0) {
      for (const agent of liveAgentRows) {
        selectedAgents.set(agent.id, agent);
      }
    }

    const agentRows = Array.from(selectedAgents.values())
      .sort((left, right) => left.name.localeCompare(right.name));

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    const projectsSvc = projectService(db);
    const issuesSvc = issueService(db);
    const routinesSvc = routineService(db);
    const allProjectsRaw = include.projects || include.issues ? await projectsSvc.list(companyId) : [];
    const allProjects = allProjectsRaw.filter((project) => !project.archivedAt);
    const allRoutines = include.issues ? await routinesSvc.list(companyId) : [];
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const projectByReference = new Map<string, typeof allProjects[number]>();
    for (const project of allProjects) {
      projectByReference.set(project.id, project);
      projectByReference.set(project.urlKey, project);
    }

    const selectedProjects = new Map<string, typeof allProjects[number]>();
    const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
    for (const selector of input.projects ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
    }

    const selectedIssues = new Map<string, Awaited<ReturnType<typeof issuesSvc.getById>>>();
    const selectedRoutines = new Map<string, typeof allRoutines[number]>();
    const routineById = new Map(allRoutines.map((routine) => [routine.id, routine]));
    const resolveIssueBySelector = async (selector: string) => {
      const trimmed = selector.trim();
      if (!trimmed) return null;
      return trimmed.includes("-")
        ? issuesSvc.getByIdentifier(trimmed)
        : issuesSvc.getById(trimmed);
    };
    for (const selector of input.issues ?? []) {
      const issue = await resolveIssueBySelector(selector);
      if (!issue || issue.companyId !== companyId) {
        const routine = routineById.get(selector.trim());
        if (routine) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
          continue;
        }
        warnings.push(`Issue selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedIssues.set(issue.id, issue);
      if (issue.projectId) {
        const parentProject = projectById.get(issue.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }

    for (const selector of input.projectIssues ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project-issues selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
      const projectIssues = await issuesSvc.list(companyId, { projectId: match.id });
      for (const issue of projectIssues) {
        selectedIssues.set(issue.id, issue);
      }
      for (const routine of allRoutines.filter((entry) => entry.projectId === match.id)) {
        selectedRoutines.set(routine.id, routine);
      }
    }

    if (include.projects && selectedProjects.size === 0) {
      for (const project of allProjects) {
        selectedProjects.set(project.id, project);
      }
    }

    if (include.issues && selectedIssues.size === 0) {
      const allIssues = await issuesSvc.list(companyId);
      for (const issue of allIssues) {
        selectedIssues.set(issue.id, issue);
        if (issue.projectId) {
          const parentProject = projectById.get(issue.projectId);
          if (parentProject) selectedProjects.set(parentProject.id, parentProject);
        }
      }
      if (selectedRoutines.size === 0) {
        for (const routine of allRoutines) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
        }
      }
    }

    const selectedProjectRows = Array.from(selectedProjects.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedIssueRows = Array.from(selectedIssues.values())
      .filter((issue): issue is NonNullable<typeof issue> => issue != null)
      .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));
    const selectedRoutineSummaries = Array.from(selectedRoutines.values())
      .sort((left, right) => left.title.localeCompare(right.title));
    const selectedRoutineRows = (
      await Promise.all(selectedRoutineSummaries.map((routine) => routinesSvc.getDetail(routine.id)))
    ).filter((routine): routine is RoutineLike => routine !== null);

    const taskSlugByIssueId = new Map<string, string>();
    const taskSlugByRoutineId = new Map<string, string>();
    const usedTaskSlugs = new Set<string>();
    for (const issue of selectedIssueRows) {
      const baseSlug = normalizeAgentUrlKey(issue.identifier ?? issue.title) ?? "task";
      taskSlugByIssueId.set(issue.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }
    for (const routine of selectedRoutineRows) {
      const baseSlug = normalizeAgentUrlKey(routine.title) ?? "task";
      taskSlugByRoutineId.set(routine.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }

    const projectSlugById = new Map<string, string>();
    const projectWorkspaceKeyByProjectId = new Map<string, Map<string, string>>();
    const usedProjectSlugs = new Set<string>();
    for (const project of selectedProjectRows) {
      const baseSlug = deriveProjectUrlKey(project.name, project.name);
      projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
    }
    const sidebarOrder = requestedSidebarOrder ?? stripEmptyValues({
      agents: sortAgentsBySidebarOrder(Array.from(selectedAgents.values()))
        .map((agent) => idToSlug.get(agent.id))
        .filter((slug): slug is string => Boolean(slug)),
      projects: selectedProjectRows
        .map((project) => projectSlugById.get(project.id))
        .filter((slug): slug is string => Boolean(slug)),
    });

    const companyPath = "COMPANY.md";
    files[companyPath] = buildMarkdown(
      {
        name: company.name,
        description: company.description ?? null,
        schema: "agentcompanies/v1",
        slug: rootPath,
      },
      "",
    );

    if (include.company && company.logoAssetId) {
      if (!storage) {
        warnings.push("Skipped company logo from export because storage is unavailable.");
      } else {
        const logoAsset = await assetRecords.getById(company.logoAssetId);
        if (!logoAsset) {
          warnings.push(`Skipped company logo ${company.logoAssetId} because the asset record was not found.`);
        } else {
          try {
            const object = await storage.getObject(company.id, logoAsset.objectKey);
            const body = await streamToBuffer(object.stream);
            companyLogoPath = `images/${COMPANY_LOGO_FILE_NAME}${resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
            files[companyLogoPath] = bufferToPortableBinaryFile(body, logoAsset.contentType);
          } catch (err) {
            warnings.push(`Failed to export company logo ${company.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    const founderosAgentsOut: Record<string, Record<string, unknown>> = {};
    const founderosProjectsOut: Record<string, Record<string, unknown>> = {};
    const founderosTasksOut: Record<string, Record<string, unknown>> = {};
    const unportableTaskWorkspaceRefs = new Map<string, { workspaceId: string; taskSlugs: string[] }>();
    const founderosRoutinesOut: Record<string, Record<string, unknown>> = {};

    const skillByReference = new Map<string, typeof companySkillRows[number]>();
    for (const skill of companySkillRows) {
      skillByReference.set(skill.id, skill);
      skillByReference.set(skill.key, skill);
      skillByReference.set(skill.slug, skill);
      skillByReference.set(skill.name, skill);
    }
    const selectedSkills = new Map<string, typeof companySkillRows[number]>();
    for (const selector of input.skills ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeSkillKey(trimmed) ?? normalizeSkillSlug(trimmed) ?? trimmed;
      const match = skillByReference.get(trimmed) ?? skillByReference.get(normalized);
      if (!match) {
        warnings.push(`Skill selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedSkills.set(match.id, match);
    }
    if (selectedSkills.size === 0) {
      for (const skill of companySkillRows) {
        selectedSkills.set(skill.id, skill);
      }
    }
    const selectedSkillRows = Array.from(selectedSkills.values())
      .sort((left, right) => left.key.localeCompare(right.key));

    const skillExportDirs = buildSkillExportDirMap(selectedSkillRows, company.issuePrefix);
    for (const skill of selectedSkillRows) {
      const packageDir = skillExportDirs.get(skill.key) ?? `skills/${normalizeSkillSlug(skill.slug) ?? "skill"}`;
      if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
        files[`${packageDir}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
        continue;
      }

      for (const inventoryEntry of skill.fileInventory) {
        const fileDetail = await companySkills.readFile(companyId, skill.id, inventoryEntry.path).catch(() => null);
        if (!fileDetail) continue;
        const filePath = `${packageDir}/${inventoryEntry.path}`;
        files[filePath] = inventoryEntry.path === "SKILL.md"
          ? await withSkillSourceMetadata(skill, fileDetail.content)
          : fileDetail.content;
      }
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const exportedInstructions = await instructions.exportFiles(agent);
        warnings.push(...exportedInstructions.warnings);

        const envInputsStart = envInputs.length;
        const exportedEnvInputs = extractPortableEnvInputs(
          slug,
          (agent.adapterConfig as Record<string, unknown>).env,
          warnings,
        );
        envInputs.push(...exportedEnvInputs);
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentEnvInputs = dedupeEnvInputs(
          envInputs
            .slice(envInputsStart)
            .filter((inputValue) => inputValue.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        const desiredSkills = readFounderOSSkillSyncPreference(
          (agent.adapterConfig as Record<string, unknown>) ?? {},
        ).desiredSkills;

        const commandValue = asString(portableAdapterConfig.command);
        if (commandValue && isAbsoluteCommand(commandValue)) {
          warnings.push(`Agent ${slug} command ${commandValue} was omitted from export because it is system-dependent.`);
          delete portableAdapterConfig.command;
        }
        for (const [relativePath, content] of Object.entries(exportedInstructions.files)) {
          const targetPath = `agents/${slug}/${relativePath}`;
          if (relativePath === exportedInstructions.entryFile) {
            files[targetPath] = buildMarkdown(
              stripEmptyValues({
                name: agent.name,
                title: agent.title ?? null,
                reportsTo: reportsToSlug,
                skills: desiredSkills.length > 0 ? desiredSkills : undefined,
              }) as Record<string, unknown>,
              content,
            );
          } else {
            files[targetPath] = content;
          }
        }

        const extension = stripEmptyValues({
          role: agent.role !== "agent" ? agent.role : undefined,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          adapter: {
            type: agent.adapterType,
            config: portableAdapterConfig,
          },
          runtime: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: (agent.budgetMonthlyCents ?? 0) > 0 ? agent.budgetMonthlyCents : undefined,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
        if (isPlainRecord(extension) && agentEnvInputs.length > 0) {
          extension.inputs = {
            env: buildEnvInputMap(agentEnvInputs),
          };
        }
        founderosAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
      }
    }

    for (const project of selectedProjectRows) {
      const slug = projectSlugById.get(project.id)!;
      const projectPath = `projects/${slug}/PROJECT.md`;
      const envInputsStart = envInputs.length;
      const exportedEnvInputs = extractPortableProjectEnvInputs(slug, project.env, warnings);
      envInputs.push(...exportedEnvInputs);
      const projectEnvInputs = dedupeEnvInputs(
        envInputs
          .slice(envInputsStart)
          .filter((inputValue) => inputValue.projectSlug === slug),
      );
      const portableWorkspaces = await buildPortableProjectWorkspaces(slug, project.workspaces, warnings);
      projectWorkspaceKeyByProjectId.set(project.id, portableWorkspaces.workspaceKeyById);
      files[projectPath] = buildMarkdown(
        {
          name: project.name,
          description: project.description ?? null,
          owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        },
        project.description ?? "",
      );
      const extension = stripEmptyValues({
        leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        targetDate: project.targetDate ?? null,
        color: project.color ?? null,
        status: project.status,
        executionWorkspacePolicy: exportPortableProjectExecutionWorkspacePolicy(
          slug,
          project.executionWorkspacePolicy,
          portableWorkspaces.workspaceKeyById,
          warnings,
        ) ?? undefined,
        workspaces: portableWorkspaces.extension,
      });
      if (isPlainRecord(extension) && projectEnvInputs.length > 0) {
        extension.inputs = {
          env: buildEnvInputMap(projectEnvInputs),
        };
      }
      founderosProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
    }

    for (const issue of selectedIssueRows) {
      const taskSlug = taskSlugByIssueId.get(issue.id)!;
      const projectSlug = issue.projectId ? (projectSlugById.get(issue.projectId) ?? null) : null;
      // All tasks go in top-level tasks/ folder, never nested under projects/
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;
      const projectWorkspaceKey = issue.projectId && issue.projectWorkspaceId
        ? projectWorkspaceKeyByProjectId.get(issue.projectId)?.get(issue.projectWorkspaceId) ?? null
        : null;
      if (issue.projectWorkspaceId && !projectWorkspaceKey) {
        const aggregateKey = `${issue.projectId ?? "no-project"}:${issue.projectWorkspaceId}`;
        const existing = unportableTaskWorkspaceRefs.get(aggregateKey);
        if (existing) {
          existing.taskSlugs.push(taskSlug);
        } else {
          unportableTaskWorkspaceRefs.set(aggregateKey, {
            workspaceId: issue.projectWorkspaceId,
            taskSlugs: [taskSlug],
          });
        }
      }
      files[taskPath] = buildMarkdown(
        {
          name: issue.title,
          project: projectSlug,
          assignee: assigneeSlug,
        },
        issue.description ?? "",
      );
      const extension = stripEmptyValues({
        identifier: issue.identifier,
        status: issue.status,
        priority: issue.priority,
        labelIds: issue.labelIds ?? undefined,
        billingCode: issue.billingCode ?? null,
        projectWorkspaceKey: projectWorkspaceKey ?? undefined,
        executionWorkspaceSettings: issue.executionWorkspaceSettings ?? undefined,
        assigneeAdapterOverrides: issue.assigneeAdapterOverrides ?? undefined,
      });
      founderosTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    for (const { workspaceId, taskSlugs } of unportableTaskWorkspaceRefs.values()) {
      const preview = taskSlugs.slice(0, 4).join(", ");
      const remainder = taskSlugs.length > 4 ? ` and ${taskSlugs.length - 4} more` : "";
      warnings.push(`Tasks ${preview}${remainder} reference workspace ${workspaceId}, but that workspace could not be exported portably.`);
    }

    for (const routine of selectedRoutineRows) {
      const taskSlug = taskSlugByRoutineId.get(routine.id)!;
      const projectSlug = routine.projectId ? (projectSlugById.get(routine.projectId) ?? null) : null;
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = routine.assigneeAgentId ? (idToSlug.get(routine.assigneeAgentId) ?? null) : null;
      files[taskPath] = buildMarkdown(
        {
          name: routine.title,
          project: projectSlug,
          assignee: assigneeSlug,
          recurring: true,
        },
        routine.description ?? "",
      );
      const extension = stripEmptyValues({
        status: routine.status !== "active" ? routine.status : undefined,
        priority: routine.priority !== "medium" ? routine.priority : undefined,
        concurrencyPolicy: routine.concurrencyPolicy !== "coalesce_if_active" ? routine.concurrencyPolicy : undefined,
        catchUpPolicy: routine.catchUpPolicy !== "skip_missed" ? routine.catchUpPolicy : undefined,
        variables: (routine.variables ?? []).length > 0 ? routine.variables : undefined,
        triggers: routine.triggers.map((trigger) => stripEmptyValues({
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled ? undefined : false,
          cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : undefined,
          timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : undefined,
          signingMode: trigger.kind === "webhook" && trigger.signingMode !== "bearer" ? trigger.signingMode ?? null : undefined,
          replayWindowSec: trigger.kind === "webhook" && trigger.replayWindowSec !== 300
            ? trigger.replayWindowSec ?? null
            : undefined,
        })),
      });
      founderosRoutinesOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    const founderosExtensionPath = ".founderos.yaml";
    const founderosAgents = Object.fromEntries(
      Object.entries(founderosAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const founderosProjects = Object.fromEntries(
      Object.entries(founderosProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const founderosTasks = Object.fromEntries(
      Object.entries(founderosTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const founderosRoutines = Object.fromEntries(
      Object.entries(founderosRoutinesOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    files[founderosExtensionPath] = buildYamlFile(
      {
        schema: "founderos/v1",
        company: stripEmptyValues({
          brandColor: company.brandColor ?? null,
          logoPath: companyLogoPath,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents ? undefined : false,
          feedbackDataSharingEnabled: company.feedbackDataSharingEnabled ? true : undefined,
          feedbackDataSharingConsentAt: company.feedbackDataSharingConsentAt?.toISOString() ?? null,
          feedbackDataSharingConsentByUserId: company.feedbackDataSharingConsentByUserId ?? null,
          feedbackDataSharingTermsVersion: company.feedbackDataSharingTermsVersion ?? null,
        }),
        sidebar: stripEmptyValues(sidebarOrder),
        agents: Object.keys(founderosAgents).length > 0 ? founderosAgents : undefined,
        projects: Object.keys(founderosProjects).length > 0 ? founderosProjects : undefined,
        tasks: Object.keys(founderosTasks).length > 0 ? founderosTasks : undefined,
        routines: Object.keys(founderosRoutines).length > 0 ? founderosRoutines : undefined,
      },
      { preserveEmptyStrings: true },
    );

    let finalFiles = filterExportFiles(files, input.selectedFiles, founderosExtensionPath);
    let resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    // Generate org chart PNG from manifest agents
    if (resolved.manifest.agents.length > 0) {
      try {
        const orgNodes = buildOrgTreeFromManifest(resolved.manifest.agents);
        const pngBuffer = await renderOrgChartPng(orgNodes);
        finalFiles["images/org-chart.png"] = bufferToPortableBinaryFile(pngBuffer, "image/png");
      } catch {
        // Non-fatal: export still works without the org chart image
      }
    }

    if (!input.selectedFiles || input.selectedFiles.some((entry) => normalizePortablePath(entry) === "README.md")) {
      finalFiles["README.md"] = generateReadme(resolved.manifest, {
        companyName: company.name,
        companyDescription: company.description ?? null,
      });
    }

    resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    return {
      rootPath,
      manifest: resolved.manifest,
      files: finalFiles,
      warnings: resolved.warnings,
      founderosExtensionPath,
    };
  }

  async function previewExport(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportPreviewResult> {
    const previewInput: CompanyPortabilityExport = {
      ...input,
      include: {
        ...input.include,
        issues:
          input.include?.issues
          ?? Boolean((input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0))
          ?? false,
      },
    };
    if (previewInput.include && previewInput.include.issues === undefined) {
      previewInput.include.issues = false;
    }
    const exported = await exportBundle(companyId, previewInput);
    return {
      ...exported,
      fileInventory: Object.keys(exported.files)
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
          path: filePath,
          kind: classifyPortableFileKind(filePath),
        })),
      counts: {
        files: Object.keys(exported.files).length,
        agents: exported.manifest.agents.length,
        skills: exported.manifest.skills.length,
        projects: exported.manifest.projects.length,
        issues: exported.manifest.issues.length,
      },
    };
  }

  async function buildPreview(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<ImportPlanInternal> {
    const mode = resolveImportMode(options);
    const requestedInclude = normalizeInclude(input.include);
    const source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);
    const manifest = source.manifest;
    const include: CompanyPortabilityInclude = {
      company: requestedInclude.company && manifest.company !== null,
      agents: requestedInclude.agents && manifest.agents.length > 0,
      projects: requestedInclude.projects && manifest.projects.length > 0,
      issues: requestedInclude.issues && manifest.issues.length > 0,
      skills: requestedInclude.skills && manifest.skills.length > 0,
    };
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    if (mode === "agent_safe" && collisionStrategy === "replace") {
      throw unprocessable("Safe import routes do not allow replace collision strategy.");
    }
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillKeys = new Set(source.manifest.skills.map((skill) => skill.key));
    const availableSkillSlugs = new Map<string, CompanyPortabilitySkillManifestEntry[]>();
    for (const skill of source.manifest.skills) {
      const existing = availableSkillSlugs.get(skill.slug) ?? [];
      existing.push(skill);
      availableSkillSlugs.set(skill.slug, existing);
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = readPortableTextFile(source.files, filePath);
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillRef of agent.skills) {
        const slugMatches = availableSkillSlugs.get(skillRef) ?? [];
        if (!availableSkillKeys.has(skillRef) && slugMatches.length !== 1) {
          warnings.push(`Agent ${agent.slug} references skill ${skillRef}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(project.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.issues) {
      const projectBySlug = new Map(manifest.projects.map((project) => [project.slug, project]));
      for (const issue of manifest.issues) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(issue.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${issue.slug}: ${issue.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${issue.path} does not declare kind: task in frontmatter.`);
        }
        if (issue.projectWorkspaceKey) {
          const project = issue.projectSlug ? projectBySlug.get(issue.projectSlug) ?? null : null;
          if (!project) {
            warnings.push(`Task ${issue.slug} references workspace key ${issue.projectWorkspaceKey}, but its project is not present in the package.`);
          } else if (!project.workspaces.some((workspace) => workspace.key === issue.projectWorkspaceKey)) {
            warnings.push(`Task ${issue.slug} references missing project workspace key ${issue.projectWorkspaceKey}.`);
          }
        }
        if (issue.recurring) {
          if (!issue.projectSlug) {
            errors.push(`Recurring task ${issue.slug} must declare a project to import as a routine.`);
          }
          if (!issue.assigneeAgentSlug) {
            errors.push(`Recurring task ${issue.slug} must declare an assignee to import as a routine.`);
          }
          const resolvedRoutine = resolvePortableRoutineDefinition(issue, parsed.frontmatter.schedule);
          warnings.push(...resolvedRoutine.warnings);
          errors.push(...resolvedRoutine.errors);
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        const scope = envInput.agentSlug
          ? ` for agent ${envInput.agentSlug}`
          : envInput.projectSlug
            ? ` for project ${envInput.projectSlug}`
            : "";
        warnings.push(`Environment input ${envInput.key}${scope} is system-dependent and may need manual adjustment after import.`);
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();
    const projectPlans: CompanyPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const issuePlans: CompanyPortabilityPreviewResult["plan"]["issuePlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }

      const existingSkills = await companySkills.listFull(input.target.companyId);
      const existingSkillKeys = new Set(existingSkills.map((skill) => skill.key));
      const existingSkillSlugs = new Set(existingSkills.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
      for (const skill of manifest.skills) {
        const skillSlug = normalizeSkillSlug(skill.slug) ?? skill.slug;
        if (existingSkillKeys.has(skill.key) || existingSkillSlugs.has(skillSlug)) {
          if (mode === "agent_safe") {
            warnings.push(`Existing skill "${skill.slug}" matched during safe import and will ${collisionStrategy === "skip" ? "be skipped" : "be renamed"} instead of overwritten.`);
          } else if (collisionStrategy === "replace") {
            warnings.push(`Existing skill "${skill.slug}" (${skill.key}) will be overwritten by import.`);
          }
        }
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (mode === "board_full" && collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (mode === "board_full" && collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    // Apply user-specified name overrides (keyed by slug)
    if (input.nameOverrides) {
      for (const ap of agentPlans) {
        const override = input.nameOverrides[ap.slug];
        if (override) {
          ap.plannedName = override;
        }
      }
      for (const pp of projectPlans) {
        const override = input.nameOverrides[pp.slug];
        if (override) {
          pp.plannedName = override;
        }
      }
      for (const ip of issuePlans) {
        const override = input.nameOverrides[ip.slug];
        if (override) {
          ip.plannedTitle = override;
        }
      }
    }

    // Warn about agents that will be overwritten/updated
    for (const ap of agentPlans) {
      if (ap.action === "update") {
        warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
      }
    }

    // Warn about projects that will be overwritten/updated
    for (const pp of projectPlans) {
      if (pp.action === "update") {
        warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
      }
    }

    if (include.issues) {
      for (const manifestIssue of manifest.issues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurring ? "Recurring task will be imported as a routine." : null,
        });
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company && mode === "board_full"
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
      },
      manifest,
      files: source.files,
      envInputs: manifest.envInputs ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
    };
  }

  async function previewImport(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input, options);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityImportResult> {
    const mode = resolveImportMode(options);
    const plan = await buildPreview(input, options);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    if (
      mode === "agent_safe"
      && (
        plan.preview.plan.companyAction === "update"
        || plan.preview.plan.agentPlans.some((entry) => entry.action === "update")
        || plan.preview.plan.projectPlans.some((entry) => entry.action === "update")
      )
    ) {
      throw unprocessable("Safe import routes only allow create or skip actions.");
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      if (mode === "agent_safe" && !options?.sourceCompanyId) {
        throw unprocessable("Safe new-company imports require a source company context.");
      }
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        const sourceMemberships = await access.listActiveUserMemberships(options.sourceCompanyId);
        if (sourceMemberships.length === 0) {
          throw unprocessable("Safe new-company import requires at least one active user membership on the source company.");
        }
      }
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
        feedbackDataSharingEnabled: include.company
          ? (sourceManifest.company?.feedbackDataSharingEnabled ?? false)
          : false,
        feedbackDataSharingConsentAt: include.company && sourceManifest.company?.feedbackDataSharingConsentAt
          ? new Date(sourceManifest.company.feedbackDataSharingConsentAt)
          : null,
        feedbackDataSharingConsentByUserId: include.company
          ? (sourceManifest.company?.feedbackDataSharingConsentByUserId ?? null)
          : null,
        feedbackDataSharingTermsVersion: include.company
          ? (sourceManifest.company?.feedbackDataSharingTermsVersion ?? null)
          : null,
      });
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        await access.copyActiveUserMemberships(options.sourceCompanyId, created.id);
      } else {
        await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      }
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company && mode === "board_full") {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
          feedbackDataSharingEnabled: sourceManifest.company.feedbackDataSharingEnabled,
          feedbackDataSharingConsentAt: sourceManifest.company.feedbackDataSharingConsentAt
            ? new Date(sourceManifest.company.feedbackDataSharingConsentAt)
            : null,
          feedbackDataSharingConsentByUserId: sourceManifest.company.feedbackDataSharingConsentByUserId,
          feedbackDataSharingTermsVersion: sourceManifest.company.feedbackDataSharingTermsVersion,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    if (include.company) {
      const logoPath = sourceManifest.company?.logoPath ?? null;
      if (!logoPath) {
        const cleared = await companies.update(targetCompany.id, { logoAssetId: null });
        targetCompany = cleared ?? targetCompany;
      } else {
        const logoFile = plan.source.files[logoPath];
        if (!logoFile) {
          warnings.push(`Skipped company logo import because ${logoPath} is missing from the package.`);
        } else if (!storage) {
          warnings.push("Skipped company logo import because storage is unavailable.");
        } else {
          const contentType = isPortableBinaryFile(logoFile)
            ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
            : inferContentTypeFromPath(logoPath);
          if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
            warnings.push(`Skipped company logo import for ${logoPath} because the file type is unsupported.`);
          } else {
            try {
              const body = portableFileToBuffer(logoFile, logoPath);
              const stored = await storage.putFile({
                companyId: targetCompany.id,
                namespace: "assets/companies",
                originalFilename: path.posix.basename(logoPath),
                contentType,
                body,
              });
              const createdAsset = await assetRecords.create(targetCompany.id, {
                provider: stored.provider,
                objectKey: stored.objectKey,
                contentType: stored.contentType,
                byteSize: stored.byteSize,
                sha256: stored.sha256,
                originalFilename: stored.originalFilename,
                createdByAgentId: null,
                createdByUserId: actorUserId ?? null,
              });
              const updated = await companies.update(targetCompany.id, {
                logoAssetId: createdAsset.id,
              });
              targetCompany = updated ?? targetCompany;
            } catch (err) {
              warnings.push(`Failed to import company logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const resultProjects: CompanyPortabilityImportResult["projects"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    const importedSlugToProjectId = new Map<string, string>();
    const importedProjectWorkspaceIdByProjectSlug = new Map<string, Map<string, string>>();
    const existingProjectSlugToId = new Map<string, string>();
    const existingProjects = await projects.list(targetCompany.id);
    for (const existing of existingProjects) {
      existingProjectSlugToId.set(existing.urlKey, existing.id);
    }

    const importedSkills = include.skills || include.agents
      ? await companySkills.importPackageFiles(targetCompany.id, pickTextFiles(plan.source.files), {
          onConflict: resolveSkillConflictStrategy(mode, plan.collisionStrategy),
        })
      : [];
    const desiredSkillRefMap = new Map<string, string>();
    for (const importedSkill of importedSkills) {
      desiredSkillRefMap.set(importedSkill.originalKey, importedSkill.skill.key);
      desiredSkillRefMap.set(importedSkill.originalSlug, importedSkill.skill.key);
      if (importedSkill.action === "skipped") {
        warnings.push(`Skipped skill ${importedSkill.originalSlug}; existing skill ${importedSkill.skill.slug} was kept.`);
      } else if (importedSkill.originalKey !== importedSkill.skill.key) {
        warnings.push(`Imported skill ${importedSkill.originalSlug} as ${importedSkill.skill.slug} to avoid overwriting an existing skill.`);
      }
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const bundlePrefix = `agents/${manifestAgent.slug}/`;
        const bundleFiles = Object.fromEntries(
          Object.entries(plan.source.files)
            .filter(([filePath]) => filePath.startsWith(bundlePrefix))
            .flatMap(([filePath, content]) => typeof content === "string"
              ? [[normalizePortablePath(filePath.slice(bundlePrefix.length)), content] as const]
              : []),
        );
        const markdownRaw = bundleFiles["AGENTS.md"] ?? readPortableTextFile(plan.source.files, manifestAgent.path);
        const entryRelativePath = normalizePortablePath(manifestAgent.path).startsWith(bundlePrefix)
          ? normalizePortablePath(manifestAgent.path).slice(bundlePrefix.length)
          : "AGENTS.md";
        if (typeof markdownRaw === "string") {
          const importedInstructionsBody = parseFrontmatterMarkdown(markdownRaw).body;
          bundleFiles[entryRelativePath] = importedInstructionsBody;
          if (entryRelativePath !== "AGENTS.md") {
            bundleFiles["AGENTS.md"] = importedInstructionsBody;
          }
        }
        const fallbackPromptTemplate = asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) || "";
        if (!markdownRaw && fallbackPromptTemplate) {
          bundleFiles["AGENTS.md"] = fallbackPromptTemplate;
        }
        if (!markdownRaw && !fallbackPromptTemplate) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported with an empty managed bundle.`);
        }

        // Apply adapter overrides from request if present
        const adapterOverride = input.adapterOverrides?.[planAgent.slug];
        const effectiveAdapterType = adapterOverride?.adapterType ?? manifestAgent.adapterType;
        const baseAdapterConfig = adapterOverride?.adapterConfig
          ? { ...adapterOverride.adapterConfig }
          : { ...manifestAgent.adapterConfig } as Record<string, unknown>;

        const desiredSkills = (manifestAgent.skills ?? []).map((skillRef) => desiredSkillRefMap.get(skillRef) ?? skillRef);
        const adapterConfigWithSkills = writeFounderOSSkillSyncPreference(
          baseAdapterConfig,
          desiredSkills,
        );
        delete adapterConfigWithSkills.promptTemplate;
        delete adapterConfigWithSkills.bootstrapPromptTemplate; // deprecated
        delete adapterConfigWithSkills.instructionsFilePath;
        delete adapterConfigWithSkills.instructionsBundleMode;
        delete adapterConfigWithSkills.instructionsRootPath;
        delete adapterConfigWithSkills.instructionsEntryFile;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: effectiveAdapterType,
          adapterConfig: adapterConfigWithSkills,
          runtimeConfig: disableImportedTimerHeartbeat(manifestAgent.runtimeConfig),
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          let updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          try {
            const materialized = await instructions.materializeManagedBundle(updated, bundleFiles, {
              clearLegacyPromptTemplate: true,
              replaceExisting: true,
            });
            updated = await agents.update(updated.id, { adapterConfig: materialized.adapterConfig }) ?? updated;
          } catch (err) {
            warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        let created = await agents.create(targetCompany.id, patch);
        await access.ensureMembership(targetCompany.id, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(
          targetCompany.id,
          "agent",
          created.id,
          "tasks:assign",
          true,
          actorUserId ?? null,
        );
        try {
          const materialized = await instructions.materializeManagedBundle(created, bundleFiles, {
            clearLegacyPromptTemplate: true,
            replaceExisting: true,
          });
          created = await agents.update(created.id, { adapterConfig: materialized.adapterConfig }) ?? created;
        } catch (err) {
          warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      // Apply reporting links once all imported agent ids are available.
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;
        if (planProject.action === "skip") {
          resultProjects.push({
            slug: planProject.slug,
            id: planProject.existingProjectId,
            action: "skipped",
            name: planProject.plannedName,
            reason: planProject.reason,
          });
          continue;
        }

        const projectLeadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? null
          : null;
        const projectWorkspaceIdByKey = new Map<string, string>();
        const projectPatch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          leadAgentId: projectLeadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? manifestProject.status as typeof PROJECT_STATUSES[number]
            : "backlog",
          env: manifestProject.env,
          executionWorkspacePolicy: stripPortableProjectExecutionWorkspaceRefs(manifestProject.executionWorkspacePolicy),
        };

        let projectId: string | null = null;
        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            resultProjects.push({
              slug: planProject.slug,
              id: null,
              action: "skipped",
              name: planProject.plannedName,
              reason: "Existing target project not found.",
            });
            continue;
          }
          projectId = updated.id;
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(updated.urlKey, updated.id);
          resultProjects.push({
            slug: planProject.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planProject.reason,
          });
        } else {
          const created = await projects.create(targetCompany.id, projectPatch);
          projectId = created.id;
          importedSlugToProjectId.set(planProject.slug, created.id);
          existingProjectSlugToId.set(created.urlKey, created.id);
          resultProjects.push({
            slug: planProject.slug,
            id: created.id,
            action: "created",
            name: created.name,
            reason: planProject.reason,
          });
        }

        if (!projectId) continue;

        for (const workspace of manifestProject.workspaces) {
          const createdWorkspace = await projects.createWorkspace(projectId, {
            name: workspace.name,
            sourceType: workspace.sourceType ?? undefined,
            repoUrl: workspace.repoUrl ?? undefined,
            repoRef: workspace.repoRef ?? undefined,
            defaultRef: workspace.defaultRef ?? undefined,
            visibility: workspace.visibility ?? undefined,
            setupCommand: workspace.setupCommand ?? undefined,
            cleanupCommand: workspace.cleanupCommand ?? undefined,
            metadata: workspace.metadata ?? undefined,
            isPrimary: workspace.isPrimary,
          });
          if (!createdWorkspace) {
            warnings.push(`Project ${planProject.slug} workspace ${workspace.key} could not be created during import.`);
            continue;
          }
          projectWorkspaceIdByKey.set(workspace.key, createdWorkspace.id);
        }
        importedProjectWorkspaceIdByProjectSlug.set(planProject.slug, projectWorkspaceIdByKey);

        const hydratedProjectExecutionWorkspacePolicy = importPortableProjectExecutionWorkspacePolicy(
          planProject.slug,
          manifestProject.executionWorkspacePolicy,
          projectWorkspaceIdByKey,
          warnings,
        );
        if (hydratedProjectExecutionWorkspacePolicy) {
          await projects.update(projectId, {
            executionWorkspacePolicy: hydratedProjectExecutionWorkspacePolicy,
          });
        }
      }
    }

    if (include.issues) {
      const routines = routineService(db);
      for (const manifestIssue of sourceManifest.issues) {
        const markdownRaw = readPortableTextFile(plan.source.files, manifestIssue.path);
        const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
        const description = parsed?.body || manifestIssue.description || null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null
          : null;
        const projectId = manifestIssue.projectSlug
          ? importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null
          : null;
        const projectWorkspaceId = manifestIssue.projectSlug && manifestIssue.projectWorkspaceKey
          ? importedProjectWorkspaceIdByProjectSlug.get(manifestIssue.projectSlug)?.get(manifestIssue.projectWorkspaceKey) ?? null
          : null;
        if (manifestIssue.projectWorkspaceKey && !projectWorkspaceId) {
          warnings.push(`Task ${manifestIssue.slug} references workspace key ${manifestIssue.projectWorkspaceKey}, but that workspace was not imported.`);
        }
        if (manifestIssue.recurring) {
          if (!projectId || !assigneeAgentId) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} is missing the project or assignee required to create a routine.`);
          }
          const resolvedRoutine = resolvePortableRoutineDefinition(manifestIssue, parsed?.frontmatter.schedule);
          if (resolvedRoutine.errors.length > 0) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} could not be imported as a routine: ${resolvedRoutine.errors.join("; ")}`);
          }
          warnings.push(...resolvedRoutine.warnings);
          const routineDefinition = resolvedRoutine.routine ?? {
            concurrencyPolicy: null,
            catchUpPolicy: null,
            variables: null,
            triggers: [],
          };
          const createdRoutine = await routines.create(targetCompany.id, {
            projectId,
            goalId: null,
            parentIssueId: null,
            title: manifestIssue.title,
            description,
            assigneeAgentId,
            priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
              ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
              : "medium",
            status: manifestIssue.status && ROUTINE_STATUSES.includes(manifestIssue.status as any)
              ? manifestIssue.status as typeof ROUTINE_STATUSES[number]
              : "active",
            concurrencyPolicy:
              routineDefinition.concurrencyPolicy && ROUTINE_CONCURRENCY_POLICIES.includes(routineDefinition.concurrencyPolicy as any)
                ? routineDefinition.concurrencyPolicy as typeof ROUTINE_CONCURRENCY_POLICIES[number]
                : "coalesce_if_active",
            catchUpPolicy:
              routineDefinition.catchUpPolicy && ROUTINE_CATCH_UP_POLICIES.includes(routineDefinition.catchUpPolicy as any)
                ? routineDefinition.catchUpPolicy as typeof ROUTINE_CATCH_UP_POLICIES[number]
                : "skip_missed",
            variables: routineDefinition.variables ?? [],
          }, {
            agentId: null,
            userId: actorUserId ?? null,
          });
          for (const trigger of routineDefinition.triggers) {
            if (trigger.kind === "schedule") {
              await routines.createTrigger(createdRoutine.id, {
                kind: "schedule",
                label: trigger.label,
                enabled: trigger.enabled,
                cronExpression: trigger.cronExpression!,
                timezone: trigger.timezone!,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            if (trigger.kind === "webhook") {
              await routines.createTrigger(createdRoutine.id, {
                kind: "webhook",
                label: trigger.label,
                enabled: trigger.enabled,
                signingMode:
                  trigger.signingMode && ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
                    ? trigger.signingMode as typeof ROUTINE_TRIGGER_SIGNING_MODES[number]
                    : "bearer",
                replayWindowSec: trigger.replayWindowSec ?? 300,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            await routines.createTrigger(createdRoutine.id, {
              kind: "api",
              label: trigger.label,
              enabled: trigger.enabled,
            }, {
              agentId: null,
              userId: actorUserId ?? null,
            });
          }
          continue;
        }
        await issues.create(targetCompany.id, {
          projectId,
          projectWorkspaceId,
          title: manifestIssue.title,
          description,
          assigneeAgentId,
          status: manifestIssue.status && ISSUE_STATUSES.includes(manifestIssue.status as any)
            ? manifestIssue.status as typeof ISSUE_STATUSES[number]
            : "backlog",
          priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
            ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
            : "medium",
          billingCode: manifestIssue.billingCode,
          assigneeAdapterOverrides: manifestIssue.assigneeAdapterOverrides,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings,
          labelIds: [],
        });
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      projects: resultProjects,
      envInputs: sourceManifest.envInputs ?? [],
      warnings,
    };
  }

  return {
    exportBundle,
    previewExport,
    previewImport,
    importBundle,
  };
}
