# Partially from https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.noble
# Ubuntu 24.04 LTS (Noble Numbat) with TurboVNC + noVNC and patchright's patched Chromium (bypasses bot detection / Cloudflare better than Firefox).
FROM ubuntu:noble

# Configuration variables are at the end!

# https://github.com/hadolint/hadolint/wiki/DL4006
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

# Install nodejs and deps for virtual display, noVNC, chromium, and pip for installing apprise.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    # Node.js
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    # TurboVNC & VirtualGL instead of Xvfb+x11vnc (smaller, faster, has a window manager)
    && curl --proto "=https" --tlsv1.2 -fsSL https://packagecloud.io/dcommander/virtualgl/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/VirtualGL.gpg \
    && curl --proto "=https" --tlsv1.2 -fsSL https://packagecloud.io/dcommander/turbovnc/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/TurboVNC.gpg \
    && curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/VirtualGL/repo/main/VirtualGL.list > /etc/apt/sources.list.d/VirtualGL.list \
    && curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/TurboVNC/repo/main/TurboVNC.list > /etc/apt/sources.list.d/TurboVNC.list \
    # update lists and install
    && apt-get update \
    && apt-get install --no-install-recommends -y \
      virtualgl turbovnc ratpoison \
      novnc websockify \
      tini \
      nodejs \
      dos2unix \
      bc \
      # pip for apprise (apt's apprise is too old); --break-system-packages below since we only need this one package and pipx would need $PATH changes
      pip \
    # Chromium (patchright) system dependencies - installing them manually instead of `npx patchright install-deps chromium` saves ~130MB:
    && apt-get install -y --no-install-recommends \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libxkbcommon0 \
      libatspi2.0-0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2t64 \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf \
      /var/lib/apt/lists/* \
      /var/cache/* \
      /var/tmp/* \
      /tmp/* \
      /usr/share/doc/* \
    && ln -s /usr/share/novnc/vnc_auto.html /usr/share/novnc/index.html \
    && pip install apprise --break-system-packages --no-cache-dir

WORKDIR /fgc
COPY package*.json ./

# Reproducible install from package-lock.json, no dev deps (eslint) in the image, no postinstall scripts (patchright's browser download is done explicitly below).
# The headless shell is kept so SHOW=0 works; add --no-shell to save ~300MB if you always run with SHOW=1.
RUN npm ci --omit=dev --ignore-scripts && npx patchright install chromium && du -h -d1 ~/.cache/ms-playwright

COPY . .

# Shell scripts need Linux line endings. On Windows, git might be configured to check out dos/CRLF line endings, so we convert them for those people in case they want to build the image. They could also use --config core.autocrlf=input
RUN dos2unix ./*.sh && chmod +x ./*.sh
COPY docker-entrypoint.sh /usr/local/bin/

# set by .github/workflows/docker.yml
ARG COMMIT=""
ARG BRANCH=""
ARG NOW=""
# need as env vars to log in docker-entrypoint.sh
ENV COMMIT=${COMMIT}
ENV BRANCH=${BRANCH}
ENV NOW=${NOW}

LABEL org.opencontainers.image.title="free-games-claimer" \
      org.opencontainers.image.description="Automatically claims free games on the Epic Games Store, Amazon Prime Gaming, GOG and Steam" \
      org.opencontainers.image.url="https://github.com/vogler/free-games-claimer" \
      org.opencontainers.image.source="https://github.com/vogler/free-games-claimer" \
      org.opencontainers.image.revision=${COMMIT} \
      org.opencontainers.image.ref.name=${BRANCH} \
      org.opencontainers.image.base.name="ubuntu:noble"

# Configure VNC via environment variables:
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
EXPOSE 5900
EXPOSE 6080

# Configure the virtual display via environment variables:
ENV WIDTH=1920
ENV HEIGHT=1080
ENV DEPTH=24

# Show browser instead of running headless
ENV SHOW=1

# HEALTHCHECK: passes if lastrun.json was updated within the last 25 hours (1500 min).
# Fails if the scheduler is stuck or hasn't run since container start.
HEALTHCHECK --interval=30m --timeout=10s --start-period=120s --retries=3 \
  CMD find /fgc/data/lastrun.json -mmin -1500 > /dev/null 2>&1 || exit 1

# Script to setup display server & VNC is always executed.
ENTRYPOINT ["docker-entrypoint.sh"]
# Default command to run. This is replaced by appending own command, e.g. `docker run ... node prime-gaming` to only run this script.
CMD node epic-games; node prime-gaming; node gog; node steam-games
# For scheduled daily runs, override CMD with: /fgc/run-scheduled.sh
