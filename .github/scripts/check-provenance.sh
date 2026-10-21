#!/usr/bin/env bash
# Exit 0 when the npm provenance of zshy@<version> names this run's repository, workflow file,
# main and commit; otherwise say what it names instead and exit non-zero, as also when there is no
# provenance to read.
#
#   check-provenance.sh <version>      (in a workflow run: reads GITHUB_REPOSITORY, GITHUB_SHA
#                                       and GITHUB_WORKFLOW_REF)
#
# npm keeps a SLSA statement with every trusted-publishing release, recording the run that built
# it. It is what ties a version on npm to a commit, so publish-latest.yml tags a version it did not
# stage itself only at the commit that statement names.
set -euo pipefail
version="${1:?usage: check-provenance.sh <version>}"
workflow="${GITHUB_WORKFLOW_REF#"$GITHUB_REPOSITORY"/}"
workflow="${workflow%%@*}"
url="https://registry.npmjs.org/-/npm/v1/attestations/zshy@$version"
statement="$(curl -sf "$url" \
  | jq -er '.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1") | .bundle.dsseEnvelope.payload' \
  | base64 -d)" \
  || { echo "no provenance for zshy@$version at $url"; exit 1; }
got="$(jq -r '.predicate.buildDefinition | [.externalParameters.workflow.repository, .externalParameters.workflow.path, .externalParameters.workflow.ref, .resolvedDependencies[0].digest.gitCommit] | join(" ")' <<<"$statement")"
want="https://github.com/$GITHUB_REPOSITORY $workflow refs/heads/main $GITHUB_SHA"
if [ "$got" != "$want" ]; then
  echo "zshy@$version was built by: $got"
  echo "this run is:               $want"
  exit 1
fi
echo "✓ zshy@$version was built from $GITHUB_SHA by $workflow"
