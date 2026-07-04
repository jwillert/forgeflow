# Provider-agnostic workflows via capability interfaces

Workflows in the Agent Workflow Gateway depend on role-based capability interfaces such as `WorkReader`, `WorkTracker`, `CodeReader`, `CodeHost`, and `CapabilityRegistry` instead of concrete GitHub, GitLab, Jira, or Bitbucket adapters. We chose this over exposing provider adapters directly because workflows should be reusable across providers, easier to test, and insulated from provider-specific API details; provider-specific behavior remains available through named optional capabilities when needed.
