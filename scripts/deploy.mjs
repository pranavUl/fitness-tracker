// Deploy to Vercel production.
//
// Vercel blocks CLI deployments whose commit author email doesn't match a
// team member. This repo's commits use a GitHub noreply address (kept out of
// the public repo on purpose), so deploying HEAD directly gets silently
// BLOCKED. This script deploys from a local-only temp commit re-authored
// with the Vercel account email, then returns to the original branch.
// The email lives in untracked git config:  git config deploy.email <email>
//
// Usage: npm run deploy

import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const read = (cmd) => execSync(cmd).toString().trim();

const email = read("git config deploy.email");
if (!email) {
  console.error("Set the deploy author first:  git config deploy.email <your-vercel-email>");
  process.exit(1);
}
if (read("git status --porcelain")) {
  console.error("Working tree is not clean — commit or stash first.");
  process.exit(1);
}

const branch = read("git rev-parse --abbrev-ref HEAD");
const name = read("git config user.name") || "deploy";

try {
  run("git checkout -q -B deploy-tmp");
  run(`git commit -q --amend --no-edit --author="${name} <${email}>"`);
  run("npx vercel@latest --prod --archive=tgz");
} finally {
  run(`git checkout -q ${branch}`);
  run("git branch -q -D deploy-tmp");
}
