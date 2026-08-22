import { spawnSync } from "node:child_process";

const generator = ".ai-life-time-machine/skill-package/scripts/generate_batch_prompt.py";
const result = spawnSync("python3", [generator, "--repo", ".", ...process.argv.slice(2)], {
  encoding: "utf8",
});

if (result.error !== undefined) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    result.stdout.replaceAll(".ai-life-time-machine/skill-package/skills/", "skills/"),
  );
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
