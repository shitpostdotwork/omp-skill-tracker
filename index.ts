/**
 * Skill Tracker Extension
 * Author: HarutoHiroki
 *
 * Fetches and tracks specific SKILL.md files from git repos.
 * On session_start: compares SHAs, updates changed files, notifies user to restart.
 * Reads config from ~/.omp/agent/skills-tracker.yml
 * Logs to ~/.omp/agent/extensions/skill-tracker/skill-tracker.log
 *
 * Set GITHUB_TOKEN or GH_TOKEN env var for higher GitHub API rate limits (5000/hour vs 60/hour).
 */

import { mkdir, appendFile } from "node:fs/promises";
import { YAML } from "bun";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const GITHUB_API = "https://api.github.com/repos";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const GITLAB_API = "https://gitlab.com/api/v4/projects";
const GITLAB_RAW = "https://gitlab.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const AGENT_DIR = getAgentDir();
const CONFIG_FILE = `${AGENT_DIR}/skills-tracker.yml`;
const SKILLS_DIR = `${AGENT_DIR}/skills`;
const STATE_FILE = `${SKILLS_DIR}/.state.json`;
const LOG_FILE = `${AGENT_DIR}/extensions/skill-tracker/skill-tracker.log`;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

const EXAMPLE_CONFIG = `# Skill Tracker Configuration
# Each repo group defines skills to fetch and track from a git host.
# On session_start, the extension compares SHAs and updates changed files.
# Edit this file to add/remove tracked skills. Skills are written to ~/.omp/agent/skills/{name}/SKILL.md
#
# Format:
#   group-name:
#     repo: owner/repo
#     ref: branch-or-tag
#     host: github | gitlab | forgejo     # optional, defaults to github
#     base: https://forgejo.example.com   # required for forgejo hosts
#     cooldown: 3600000                   # optional, ms cooldown between checks; defaults to 1 hour (3600000)
#     skills:
#       - name: local-skill-name
#         path: path/to/SKILL.md
#
# GitHub example:
# my-skills:
#   repo: example-org/skills-repo
#   ref: main
#   skills:
#     - name: my-skill
#       path: skills/my-skill/SKILL.md
#
# GitLab example:
# gitlab-skills:
#   repo: example-org/skills-repo
#   ref: main
#   host: gitlab
#   skills:
#     - name: my-gitlab-skill
#       path: skills/my-gitlab-skill/SKILL.md
#
# Forgejo example:
# forgejo-skills:
#   repo: example-org/skills-repo
#   ref: main
#   host: forgejo
#   base: https://forgejo.example.com
#   skills:
#     - name: my-forgejo-skill
#       path: skills/my-forgejo-skill/SKILL.md
#
`;

type HostType = "github" | "gitlab" | "forgejo";

interface TrackedSkill {
  name: string;
  repo: string;
  path: string;
  ref: string;
  host: HostType;
  base?: string;
  cooldown: number;
}

interface SkillState {
  [name: string]: {
    sha: string;
    checkedAt: number;
  };
}

const log = async (msg: string) => {
  try {
    const ts = new Date().toISOString();
    await appendFile(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {
    // ignore log errors
  }
};

async function ensureConfig(): Promise<void> {
  try {
    await Bun.file(CONFIG_FILE).exists();
  } catch {
    await Bun.write(CONFIG_FILE, EXAMPLE_CONFIG, { mode: 0o644 });
    await log("created example config");
  }
}

async function loadTrackedSkills(): Promise<TrackedSkill[]> {
  try {
    const content = await Bun.file(CONFIG_FILE).text();
    const config = YAML.parse(content);
    const skills: TrackedSkill[] = [];
    for (const [_key, group] of Object.entries(config)) {
      if (typeof group !== "object" || !group.repo || !group.skills) continue;
      const g = group as { repo: string; ref: string; host?: string; base?: string; cooldown?: number; skills: Array<{ name: string; path: string }> };
      const host = (g.host as HostType) ?? "github";
      const cooldown = g.cooldown ?? DEFAULT_COOLDOWN_MS;
      if (host === "forgejo" && !g.base) {
        await log(`forgejo group "${_key}" missing base URL, skipping`);
        continue;
      }
      for (const s of g.skills) {
        skills.push({ name: s.name, repo: g.repo, path: s.path, ref: g.ref ?? "main", host, base: g.base, cooldown });
      }
    }
    await log(`loaded ${skills.length} tracked skills`);
    return skills;
  } catch (err) {
    await log(`failed to load config: ${err}`);
    return [];
  }
}

async function readState(): Promise<SkillState> {
  try {
    const content = await Bun.file(STATE_FILE).text();
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeState(state: SkillState): Promise<void> {
  try {
    await Bun.write(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o644 });
    await log(`state written: ${Object.keys(state).length} entries`);
  } catch (err) {
    await log(`failed to write state: ${err}`);
  }
}

async function getRepoTree(skill: TrackedSkill): Promise<{ tree: Record<string, string>; rateLimited: false } | { tree: null; rateLimited: boolean }> {
  const { repo, ref, host, base } = skill;

  try {
    if (host === "github") {
      const headers: Record<string, string> = { "Accept": "application/vnd.github.v3+json" };
      if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
      const res = await fetch(`${GITHUB_API}/${repo}/git/trees/${ref}?recursive=1`, { headers });

      if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        await log("rate limit hit on GitHub tree fetch");
        return { tree: null, rateLimited: true };
      }

      if (!res.ok) return { tree: null, rateLimited: false };
      const data = await res.json();
      const tree: Record<string, string> = {};
      for (const entry of data.tree ?? []) {
        if (entry.type === "blob") tree[entry.path] = entry.sha;
      }
      return { tree, rateLimited: false };
    }

    if (host === "gitlab") {
      const encodedRepo = encodeURIComponent(repo);
      const res = await fetch(`${GITLAB_API}/${encodedRepo}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true`);
      if (!res.ok) return { tree: null, rateLimited: false };
      const data = await res.json();
      const tree: Record<string, string> = {};
      for (const entry of data ?? []) {
        if (entry.type === "blob") tree[entry.path] = entry.sha;
      }
      return { tree, rateLimited: false };
    }

    if (host === "forgejo") {
      const res = await fetch(`${base}/api/v1/repos/${repo}/git/trees/${ref}?recursive=1`);
      if (!res.ok) return { tree: null, rateLimited: false };
      const data = await res.json();
      const tree: Record<string, string> = {};
      for (const entry of data.tree ?? []) {
        if (entry.type === "blob") tree[entry.path] = entry.sha;
      }
      return { tree, rateLimited: false };
    }

    return { tree: null, rateLimited: false };
  } catch (err) {
    await log(`tree fetch failed for ${repo}@${ref} (${host}): ${err}`);
    return { tree: null, rateLimited: false };
  }
}

async function checkForUpdates(ctx: Parameters<Parameters<typeof pi.on>[1]>[1], force: boolean): Promise<void> {
  await ensureConfig();
  const trackedSkills = await loadTrackedSkills();
  if (trackedSkills.length === 0) {
    ctx.ui.notify("skill-tracker: no skills configured in " + CONFIG_FILE, "warn");
    return;
  }
  const state = await readState();
  const updated: string[] = [];
  await mkdir(SKILLS_DIR, { recursive: true, mode: 0o755 });

  // Group skills by repo+ref+host+base so we can fetch one tree per unique source
  const repoGroups = new Map<string, { tree: Record<string, string> | null; skills: TrackedSkill[]; host: HostType }>();
  for (const skill of trackedSkills) {
    const key = `${skill.repo}@${skill.ref}@${skill.host}${skill.base ? `:${skill.base}` : ""}`;
    if (!repoGroups.has(key)) repoGroups.set(key, { tree: null, skills: [], host: skill.host });
    repoGroups.get(key)!.skills.push(skill);
  }

  // Fetch trees for each unique repo+ref+host (one API call per repo)
  for (const [key, group] of repoGroups) {
    const result = await getRepoTree(group.skills[0]);
    if (result.rateLimited) {
      ctx.ui.notify("skill-tracker: API rate limit hit. Set GITHUB_TOKEN env var for GitHub repos, or try again later.", "warn");
      return;
    }
    group.tree = result.tree;
  }

  const now = Date.now();
  for (const skill of trackedSkills) {
    const filePath = `${SKILLS_DIR}/${skill.name}/SKILL.md`;
    const existing = state[skill.name];

    // Skip if checked recently and file exists (unless forced)
    if (!force && existing && existing.checkedAt > now - skill.cooldown) {
      const exists = await Bun.file(filePath).exists();
      if (exists) continue;
    }

    const tree = repoGroups.get(`${skill.repo}@${skill.ref}@${skill.host}${skill.base ? `:${skill.base}` : ""}`)?.tree;
    const remoteSha = tree?.[skill.path];

    if (!remoteSha) continue;

    // Update checkedAt even if no change
    state[skill.name] = { sha: remoteSha, checkedAt: now };

    const exists = await Bun.file(filePath).exists();

    // Up to date
    if (existing?.sha === remoteSha && exists) continue;

    // New or updated: fetch content from raw (separate rate limit, much higher)
    try {
      const { repo, ref, path, host, base } = skill;
      let url: string;
      if (host === "github") {
        url = `${GITHUB_RAW}/${repo}/${ref}/${path}`;
      } else if (host === "gitlab") {
        url = `${GITLAB_RAW}/${repo}/-/raw/${ref}/${path}`;
      } else {
        url = `${base}/${repo}/raw/${ref}/${path}`;
      }
      const res = await fetch(url);
      if (!res.ok) continue;
      const content = await res.text();
      const skillDir = `${SKILLS_DIR}/${skill.name}`;
      await mkdir(skillDir, { recursive: true });
      await Bun.write(filePath, content, { mode: 0o644 });
      updated.push(skill.name);
      await log(`updated: ${skill.name}`);
    } catch (err) {
      await log(`failed to fetch content for ${skill.name}: ${err}`);
    }
  }

  await writeState(state);

  if (updated.length > 0) {
    const skillList = updated.map(s => `• ${s}`).join("\n");
    ctx.ui.notify(`skill-tracker: ${updated.length} skill(s) updated:\n${skillList}\nRestart to apply.`, "info");
  } else if (force) {
    ctx.ui.notify("skill-tracker: all skills up to date", "info");
  }
}

export default async function(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await log("session_start");
    await checkForUpdates(ctx, false);
  });

  pi.registerCommand("skill-tracker-refresh", {
    description: "Check for skill updates (add 'force' to ignore cooldown)",
    handler: async (args, ctx) => {
      const force = args.includes("force");
      await log(`manual refresh${force ? " (forced)" : ""}`);
      await checkForUpdates(ctx, force);
    },
  });
}