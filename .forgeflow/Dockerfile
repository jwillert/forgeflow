FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH=/home/agent/.local/bin:/home/agent/.npm-global/bin:$PATH

# Install Pi Agent. Runtime auth is mounted from the host at ~/.pi/agent.
RUN npm install -g @earendil-works/pi-coding-agent
RUN mkdir -p /home/agent/.pi/agent \
  && echo '{"defaultProvider":"openai-codex","defaultModel":"gpt-5.5","theme":"dark"}' > /home/agent/.pi/agent/settings.json

ENTRYPOINT ["sleep", "infinity"]
