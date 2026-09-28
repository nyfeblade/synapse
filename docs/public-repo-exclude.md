# Public repo: paths that never go in

The public repo is made from this tree with the paths below left out. Everything else is public, and
`scripts/public-scan.ts` (run by `shared/test/public-tree.test.ts` in `npm test`) checks every one of
those files, of every type, against its rules.

## Publishing

Publish from a fresh repository with one commit of this tree minus these paths, never the working
repository's history. Make that commit with an explicit public identity, so neither the machine's
configured name nor its hostname lands in it:

```sh
git -c user.name=nyfeblade -c user.email=<id>+nyfeblade@users.noreply.github.com commit -m "Synapse"
git log --format='%an %ae %cn %ce'   # must show only that identity before anything is pushed
```

Build the release from a clean clone with its own `npm install` (not a checkout whose `node_modules`
links into another folder: the bundles would carry that folder's path).

Syntax, one per line inside the block: `dir/` leaves out a folder, `*` matches within one name, `**`
matches any run of folders, anything else is one file. `#` starts a comment.

```paths
# Working material
test-reports/
tools/private/
.scratch/
.synapse-observe/
.synapse-observe-v2/
.superpowers/
.build-cache/
K-9/

# Design material
design/
docs/ui/

# Internal process
docs/superpowers/
docs/spec/
docs/lab/
docs/HANDOFF.md
docs/backlog.md
docs/differentiators.md
docs/marketplace-target.md
docs/ui-audit-playbook.md
docs/motion-spec.md

# Private notes
docs/private/

# Release audit
**/public-release-plan.md

# Agent tooling
.claude/

# Research
research/

# Working logs
docs/bug-log.md
docs/decisions.md
```
