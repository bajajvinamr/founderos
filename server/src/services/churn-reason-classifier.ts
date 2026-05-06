/**
 * Churn reason classifier — deterministic categorization of customer cancellation reasons.
 *
 * Classifies raw cancellation text into one of 8 safe categories without returning raw text.
 * This prevents PII leakage and prompt injection into downstream LLM email generation.
 *
 * Safety invariant: the function NEVER returns raw user-supplied text in the result.
 * Only category labels leave the function — even on "other", raw text is redacted.
 */

export const CHURN_REASON_CATEGORIES = [
  "pricing",
  "missing_features",
  "competitor",
  "low_engagement",
  "support_issue",
  "technical_issue",
  "team_decision",
  "other",
] as const;

export type ChurnReasonCategory = (typeof CHURN_REASON_CATEGORIES)[number];

export interface ClassificationResult {
  category: ChurnReasonCategory;
  confidence: "high" | "medium" | "low";
}

interface CategoryPatterns {
  patterns: RegExp[];
  weight: number;
}

const CATEGORY_KEYWORDS: Record<ChurnReasonCategory, CategoryPatterns> = {
  pricing: {
    patterns: [
      /\b(price|pricing|cost|expensive|afford|cheap|budget|billing|too\s+much|fee)\b/i,
    ],
    weight: 1,
  },
  missing_features: {
    patterns: [
      /\b(missing|don't\s+have|wanted|need|lacks?|no\s+(\w+\s+)?support\s+for|capabilit)\b/i,
    ],
    weight: 1,
  },
  competitor: {
    patterns: [
      /\b(competitor|switched\s+to|moved\s+to|using\s+(another|different)|alternative|instead)\b/i,
    ],
    weight: 1,
  },
  low_engagement: {
    patterns: [
      /\b(don'?t\s+use|never\s+used|not\s+(used|active|engaged)|didn'?t\s+activate|forgot|abandoned|never\s+had\s+time)\b/i,
    ],
    weight: 1,
  },
  support_issue: {
    patterns: [
      /\b(support|response|help|customer\s+service|unresponsive|ticket)\b/i,
    ],
    weight: 1,
  },
  technical_issue: {
    patterns: [
      /\b(bug|broken|crash|error|down|outage|performance|glitch)\b/i,
    ],
    weight: 1,
  },
  team_decision: {
    patterns: [
      /\b(team\s+(decision|decided)|org|company|leadership|director|management|consolidat)\b/i,
    ],
    weight: 1,
  },
  other: {
    patterns: [],
    weight: 0,
  },
};

/**
 * Classify a raw churn reason string into a safe category.
 *
 * Returns only the category label and confidence — never raw text.
 * Null/empty inputs return category="other", confidence="low".
 */
export function classifyChurnReason(
  rawText: string | null | undefined,
): ClassificationResult {
  // Handle null/empty/undefined input safely
  if (!rawText || typeof rawText !== "string" || rawText.trim() === "") {
    return { category: "other", confidence: "low" };
  }

  const text = rawText.trim();

  // Count matches per category
  const matchCounts: Record<ChurnReasonCategory, number> = {
    pricing: 0,
    missing_features: 0,
    competitor: 0,
    low_engagement: 0,
    support_issue: 0,
    technical_issue: 0,
    team_decision: 0,
    other: 0,
  };

  // Test each category pattern
  for (const category of CHURN_REASON_CATEGORIES) {
    if (category === "other") continue; // "other" has no patterns

    const { patterns } = CATEGORY_KEYWORDS[category];
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        matchCounts[category]++;
      }
    }
  }

  // Find the category with the most matches
  let bestCategory: ChurnReasonCategory = "other";
  let maxMatches = 0;
  let matchingCategoryCount = 0;

  for (const category of CHURN_REASON_CATEGORIES) {
    if (category === "other") continue;

    if (matchCounts[category] > maxMatches) {
      maxMatches = matchCounts[category];
      bestCategory = category;
      matchingCategoryCount = 1;
    } else if (matchCounts[category] === maxMatches && maxMatches > 0) {
      matchingCategoryCount++;
    }
  }

  // No matches found
  if (maxMatches === 0) {
    return { category: "other", confidence: "low" };
  }

  // Determine confidence based on match count and uniqueness
  if (matchingCategoryCount > 1) {
    // Multiple categories matched equally
    return { category: bestCategory, confidence: "medium" };
  }

  if (maxMatches === 1) {
    // Single match — high confidence
    return { category: bestCategory, confidence: "high" };
  }

  // Multiple matches in same category — medium confidence
  return { category: bestCategory, confidence: "medium" };
}

/**
 * Cluster churn reasons across multiple events.
 *
 * Returns only category counts and statistics — never raw text.
 */
export interface ChurnReasonCluster {
  totalEvents: number;
  categoryCounts: Record<ChurnReasonCategory, number>;
  dominantCategory: ChurnReasonCategory;
}

export function clusterChurnReasons(
  events: Array<{ rawText: string | null | undefined }>,
): ChurnReasonCluster {
  const categoryCounts: Record<ChurnReasonCategory, number> = {
    pricing: 0,
    missing_features: 0,
    competitor: 0,
    low_engagement: 0,
    support_issue: 0,
    technical_issue: 0,
    team_decision: 0,
    other: 0,
  };

  // Classify each event and tally
  for (const event of events) {
    const result = classifyChurnReason(event.rawText);
    categoryCounts[result.category]++;
  }

  // Find dominant category (highest count, alphabetically first on ties)
  let dominantCategory: ChurnReasonCategory = "other";
  let maxCount = 0;

  for (const category of CHURN_REASON_CATEGORIES) {
    const count = categoryCounts[category];
    if (count > maxCount) {
      maxCount = count;
      dominantCategory = category;
    } else if (count === maxCount && maxCount > 0 && category < dominantCategory) {
      dominantCategory = category;
    }
  }

  return {
    totalEvents: events.length,
    categoryCounts,
    dominantCategory,
  };
}
