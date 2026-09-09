#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
# Treat renames as a deletion plus an addition: both paths affect the gate.
# Include deletions and use NUL records so spaces/newlines cannot split paths.
git diff --no-renames --name-only -z "$BASE_SHA...$HEAD_SHA" > "$changed_files"
docs_only=true
style_only=true
full=false
cli_only=true
skill_changed=false
browser=false
node_all=false
package_checks=false
while IFS= read -r -d '' file; do
  case "$file" in
    tests/*browser.test.*|packages/cli/src/renderer/*|packages/cli/src/launcher/*|packages/cli/src/playground/*|packages/cli/src/vite*|packages/cli/src/react*|packages/cli/src/ui.ts|packages/schemastery-ui/*|.github/workflows/check.yml|.github/actions/*|vitest.config.*|scripts/ci-scope.sh|scripts/test-test-projects.mjs)
      browser=true ;;
  esac
  case "$file" in
    package.json|package-lock.json|packages/*/package.json)
      node_all=true
      package_checks=true
      ;;
  esac
  case "$file" in
    skills/cordisx-plugin-development/*) skill_changed=true ;;
  esac
  case "$file" in
    skills/cordisx-plugin-development/*.md|skills/cordisx-plugin-development/version.json|skills/cordisx-plugin-development/agents/openai.yaml)
      # Shipped Skill prose and metadata have a dedicated package/deployment gate.
      continue
      ;;
    .agents/docs/*.md|.agents/docs/*.markdown)
      continue
      ;;
  esac
  case "$file" in
    *.md|*.markdown) continue ;;
    *) docs_only=false ;;
  esac
  case "$file" in
    *.css|*.md|*.markdown) ;;
    *) style_only=false ;;
  esac
  case "$file" in
    packages/cli/src/*|tests/*|*.md|*.markdown) ;;
    *) cli_only=false ;;
  esac
  case "$file" in
    .npmrc|.github/*|scripts/*|config/*|cordisx.config.*|packages/channel-runtime/*|packages/cli/scripts/*|packages/cli/src/adapters/*|packages/cli/src/cli/*|packages/cli/src/config/*|packages/cli/src/launcher/*|packages/cli/src/providers/*|packages/cli/src/renderer/adapter*|packages/cli/src/contracts.ts|packages/cli/src/agent-tools.ts|packages/cli/src/react.ts|packages/cli/src/react-jsx-*|packages/cli/src/ui.ts|packages/cli/src/vite.ts|packages/cli/src/*contract*|packages/cli/src/*permission*|packages/cli/src/*document*|packages/cli/src/*store*|packages/cli/src/*lifecycle*|packages/cli/src/*session*|packages/cli/src/*transport*|packages/cli/src/*connector*|packages/cli/src/*channel*|skills/*|tsconfig*.json|packages/*/tsconfig*.json|vitest.config.*|vite.config.*|eslint.config.*|stylelint.config.*|dprint.json|.lintstagedrc.*|.gitmodules)
      full=true
      ;;
  esac
done < "$changed_files"
test -s "$changed_files" || full=true
if [[ "$node_all" == true && "$browser" != true ]]; then
  browser=$(node "$(dirname "${BASH_SOURCE[0]}")/ci-browser-dependencies.mjs")
fi
write_outputs() {
  echo "docs_only=$docs_only"
  echo "style_only=$style_only"
  echo "full=$full"
  echo "cli_only=$cli_only"
  echo "skill_changed=$skill_changed"
  echo "browser=$browser"
  echo "node_all=$node_all"
  echo "package_checks=$package_checks"
}
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  write_outputs >> "$GITHUB_OUTPUT"
else
  write_outputs
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### Host pull-request scope'
    echo
    echo "- base: \`$BASE_SHA\`"
    echo "- head: \`$HEAD_SHA\`"
    echo "- docs/Skill content only: \`$docs_only\`"
    echo "- full gate: \`$full\`"
    echo "- browser semantics affected: \`$browser\`"
    echo "- dependency resolution changed (all Node suites): \`$node_all\`"
    echo "- CLI dependency closure only: \`$cli_only\`"
    echo "- shipped Skill changed: \`$skill_changed\`"
    echo '- changed paths (including deleted and old renamed paths):'
    while IFS= read -r -d '' file; do
      printf '  - `%q`\n' "$file"
    done < "$changed_files"
  } >> "$GITHUB_STEP_SUMMARY"
fi
