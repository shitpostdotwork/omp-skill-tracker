# omp-skill-tracker

Have you ever ran into duplicated skills from multiple sources? You install one pack and it has skills you already have from another superpack, so you give up and just download some of the skills manually. But then the upstream repo updates the skills making your local copy stale and you're running off old instructions without knowing it.

Oh do I have the solution for YOU 🫵

This extension tracks your hand-picked skills from these packs by SHA. On session start (if cooldown has elapsed) it checks whether remote files changed, pulls updates, and notifies you to restart.

## How it works

1. You edit `~/.omp/agent/skills-tracker.yml` and list the skills you want to track (repo, branch, file path, local name).
2. On `session_start`, the extension fetches each file's blob SHA from the host API (GitHub, GitLab, or Forgejo).
3. If the SHA changed since last check, it downloads the new content and writes it to `~/.omp/agent/skills/{name}/SKILL.md`.
4. It saves the SHA to `~/.omp/agent/skills/.state.json` for next time.
5. If any skills updated, it notifies you to restart the session (so OMP reloads the new skill definitions).

## Config format

`~/.omp/agent/skills-tracker.yml`:

```yaml
group-name:
  repo: owner/repo
  ref: branch-or-tag
  host: github | gitlab | forgejo     # optional, defaults to github
  base: https://forgejo.example.com   # required for forgejo hosts
  cooldown: 3600000                   # optional, ms cooldown between checks; defaults to 1 hour (3600000)
  skills:
    - name: local-skill-name
      path: path/to/SKILL.md
```

- `group-name` is arbitrary, just for organization.
- `repo` is the owner/repo.
- `ref` is the branch or tag to track.
- `host` is the git host; defaults to `github` if omitted.
- `base` is the base URL for Forgejo instances (e.g., `https://forgejo.example.com`); required when `host: forgejo`.
- `cooldown` is milliseconds to wait after a check before checking again; defaults to 1 hour (3600000).
- `name` is the local skill name (becomes `skills/{name}/SKILL.md`).
- `path` is the file path inside the repo.

## Installation

Drop `skill-tracker` into `~/.omp/agent/extensions/` and restart OMP. On first run it creates `~/.omp/agent/skills-tracker.yml` with an example config. Edit that file and add the skills you want to track.

**Pi users:** change line 15-16 of `index.ts` from `@oh-my-pi/pi-coding-agent` to `@earendil-works/pi-coding-agent`. That's the only difference between the two platforms.

**Tip:** set `GITHUB_TOKEN` or `GH_TOKEN` env var for higher API rate limits.

## Usage

Start tracking a skill:

1. Open `~/.omp/agent/skills-tracker.yml`.
2. Add a group entry with the repo and skills:

   ```yaml
   # GitHub (default)
   github-pack:
     repo: some-user/some-skills-repo
     ref: main
     skills:
       - name: my-skill
         path: skills/my-skill/SKILL.md

   # GitLab
   gitlab-pack:
     repo: some-user/some-skills-repo
     ref: main
     host: gitlab
     skills:
       - name: my-gitlab-skill
         path: skills/my-gitlab-skill/SKILL.md

   # Forgejo (requires base URL)
   forgejo-pack:
     repo: some-user/some-skills-repo
     ref: main
     host: forgejo
     base: https://forgejo.example.com
     skills:
       - name: my-forgejo-skill
         path: skills/my-forgejo-skill/SKILL.md
   ```

3. Restart OMP. The extension fetches the skill on session start and writes it to `~/.omp/agent/skills/my-skill/SKILL.md`.
4. Done. Updates happen on each session start (respecting cooldown); you get notified when a skill changes.

To stop tracking a skill: remove its entry from the config. The local file is NOT deleted automatically (in case you want to keep it); delete it yourself if you don't need it.

## Commands

Run `/skill-tracker-refresh` in the OMP chat to manually check for updates without restarting:

- `/skill-tracker-refresh` - check for updates (respects cooldown).
- `/skill-tracker-refresh force` - check all skills immediately, ignoring cooldown.

Useful when you suspect a skill changed upstream and want to check now instead of waiting for cooldown to expire.

## Notes

- **One skill per name.** If two repos have a skill with the same `name`, the last one in the config wins. Use unique names to avoid overwriting.
- **Rate limiting.** If you hit an API rate limit, the extension notifies you and skips the affected skills.

## Troubleshooting

**Skill not appearing after restart.** Check that the `path` is correct (relative to repo root, including `SKILL.md`). The extension logs a warning if it can't fetch the file.

**Config file missing.** The extension creates it on first run. If it's gone, restart OMP and it regenerates.

**SHA check failing.** The extension uses the host API to get the blob SHA. If the repo or branch doesn't exist, or the file was moved, it skips that skill silently.

## Contributing

Bug reports, feature requests, and PRs are welcome.

- **Report a bug:** open an issue at <https://github.com/ShitpostDotWork/omp-skill-tracker/issues> and include:
  - What you expected vs what happened.
  - Relevant config (your `skills-tracker.yml` entries, redacted if needed).
  - Logs from `~/.omp/agent/extensions/skill-tracker/skill-tracker.log`.

- **Propose a feature:** open an issue with a short description of the use case.

- **Submit a PR:** fork the repo, make your changes, and open a PR. Keep it small and focused.
