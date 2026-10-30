import { z } from "zod";

/** Project names are shown in the header, so keep them short and readable. */
export const PROJECT_NAME_MIN = 2;
export const PROJECT_NAME_MAX = 60;
export const PROJECT_SLUG_MAX = 48;

export const projectNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(PROJECT_NAME_MIN, `Project name must be at least ${PROJECT_NAME_MIN} characters.`)
    .max(PROJECT_NAME_MAX, `Project name must be ${PROJECT_NAME_MAX} characters or fewer.`),
});

const optionalUrl = (check: (url: URL) => boolean, message: string) =>
  z.string().trim().transform((value) => value || null).pipe(
    z.string().nullable().refine((value) => {
      if (value === null) return true;
      try { return check(new URL(value)); } catch { return false; }
    }, message),
  );

export const projectSettingsSchema = z.object({
  name: z.string().trim().min(PROJECT_NAME_MIN, `Project name must be at least ${PROJECT_NAME_MIN} characters.`).max(PROJECT_NAME_MAX, `Project name must be ${PROJECT_NAME_MAX} characters or fewer.`),
  goal: z.string().trim().max(4000, "The project goal must be 4,000 characters or fewer.").transform((value) => value || null),
  repoUrl: optionalUrl((url) =>
    url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(url.pathname) && !url.search && !url.hash,
  "Enter a GitHub repository URL, such as https://github.com/owner/repository."),
  stagingUrl: optionalUrl((url) => url.protocol === "https:",
    "Enter a valid HTTPS staging URL."),
});

const areaPathPattern = z.string().trim().min(1).max(256).refine(
  (path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."),
  "Use a project-relative path pattern without parent-directory segments.",
);

export const projectAreaSchema = z.object({
  name: z.string().trim().min(2, "Area name must be at least 2 characters.").max(60, "Area name must be 60 characters or fewer."),
  description: z.string().trim().max(1000, "The area description must be 1,000 characters or fewer.").transform((value) => value || null),
  paths: z.string().trim().max(5000, "Area paths must be 5,000 characters or fewer.").transform((value) => [...new Set(value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))]).pipe(z.array(areaPathPattern).max(25, "An area can have at most 25 path patterns.")),
});

/**
 * A URL-safe slug from a display name. Kept deterministic so the same name
 * gets the same base; collisions are resolved by `nextProjectSlug`.
 */
export function projectSlugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX);
  return slug || "project";
}

/** `base`, or `base-2`, `base-3`, ... when another project already uses it. */
export function nextProjectSlug(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, PROJECT_SLUG_MAX - tail.length).replace(/-+$/g, "")}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`Could not find a free slug for "${base}".`);
}

export function parseRewardConfigFromFormData(formData: FormData) {
  const hasCustomRewards =
    formData.has("solverPoints") ||
    formData.has("reporterPoints") ||
    formData.has("reviewerPoints") ||
    formData.has("rewardGuidelines");

  if (!hasCustomRewards) return null;

  const solver = formData.get("solverPoints");
  const reporter = formData.get("reporterPoints");
  const reviewer = formData.get("reviewerPoints");
  const guidelines = String(formData.get("rewardGuidelines") ?? "").trim();

  return {
    solver: solver ? Number(solver) : undefined,
    reporter: reporter ? Number(reporter) : undefined,
    reviewer: reviewer ? Number(reviewer) : undefined,
    guidelines: guidelines || null,
  };
}
