#!/bin/sh
# Clones REPO_URL into /data/repo on first start, then serves it. After that
# the clone is the app's: it fetches on its own and offers new commits as
# "Pull and rescan", so nothing here resets or pulls.
#
# With CODEFLIGHT_REPOS_DIR instead, there's no one repo: the app clones the
# GitHub repos you give it into that folder and switches between them.
#
#   REPO_URL     the repository (https; ssh works with a key in $HOME/.ssh)
#   REPO_BRANCH  the branch to check out (default: the remote's default)
#   GIT_TOKEN    a token for private repos over https, used by git and go
set -eu
if [ -z "${CODEFLIGHT_REPOS_DIR:-}" ]; then
  : "${REPO_URL:?Set REPO_URL to the repository to map, or CODEFLIGHT_REPOS_DIR to open any GitHub repo}"
fi
REPO_DIR="${REPO_DIR:-/data/repo}"

mkdir -p "$HOME" /data/cache
git config --global --replace-all safe.directory '*'
if [ -n "${GIT_TOKEN:-}" ]; then
  # Read from the environment each time: the token is never written to disk.
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=${GIT_TOKEN}"; }; f'
  # Private Go modules on GitHub come through the same token.
  git config --global url."https://github.com/".insteadOf "git@github.com:"
fi

cd /app
if [ -n "${CODEFLIGHT_REPOS_DIR:-}" ]; then
  mkdir -p "$CODEFLIGHT_REPOS_DIR"
  exec node_modules/.bin/tsx server/index.ts
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Cloning $REPO_URL into $REPO_DIR"
  git clone ${REPO_BRANCH:+--branch "$REPO_BRANCH"} "$REPO_URL" "$REPO_DIR.partial"
  mv "$REPO_DIR.partial" "$REPO_DIR"
fi

exec node_modules/.bin/tsx server/index.ts "$REPO_DIR"
