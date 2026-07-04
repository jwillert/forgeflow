# Context Glossary

## Forgeflow

The project/package name for the Agent Workflow Gateway.

## Agent Workflow Gateway

A standalone TypeScript package/service that ingests external work signals from code hosting and work tracking systems, matches them against scripted workflows, and runs accepted work outside of CI/CD pipelines on user-controlled infrastructure.

Short form: **Gateway**.

## Gateway

Short form for **Agent Workflow Gateway**. Use only when the surrounding context already makes the agent workflow domain clear.

## Provider

An external system that Forgeflow integrates with, such as GitHub, GitLab, Jira, or Bitbucket.

## Code Forge

A provider that hosts repositories and change requests, such as GitHub, GitLab, or Bitbucket. Jira is a provider, but not a code forge.

## Provider Adapter

A concrete integration with an external provider such as GitHub, GitLab, Jira, or Bitbucket. A provider adapter hides provider-specific API details and may satisfy one or more capability interfaces such as event discovery, work tracking, or code hosting.

## Capability Interface

A small role-based interface exposed by the Gateway, such as event discovery, work tracking, or code hosting. Workflows and engine code depend on capability interfaces instead of depending directly on provider adapters.

## Event Source

A capability interface that discovers provider-independent events from an external provider. Event sources emit normalized events rather than workflow-specific triggers.

## Polling Event Source

An event source that discovers normalized events by periodically querying a provider and advancing a sync cursor.

## Webhook Event Source

An event source that discovers normalized events by normalizing provider webhook payloads.

## Externalized Workflow

A user-defined TypeScript workflow that Forgeflow runs outside of a CI/CD pipeline. An externalized workflow may call local scripts, Sandcastle agent workflows, shell commands, Hermes, provider CLIs, or project-specific tooling directly.

## Workflow Matcher

The scripted decision function of a workflow. A workflow matcher receives a single normalized event plus read-oriented state and capabilities, then returns whether the workflow should ignore, reject, defer, or accept the event as an agent command.

## Match Decision

The result returned by a workflow matcher for a single normalized event. `ignore` means the workflow is not relevant. `reject` means the event was relevant but invalid and should be consumed. `defer` means the event is relevant but not ready and may be re-evaluated later. `accept` means the event should create or continue an agent command.

## Projection Action

An explicit side effect that projects workflow state back to an external provider, such as adding a label, removing a label, or writing a comment. Workflows script projection actions directly instead of relying on opaque lifecycle aliases such as `markRunning` or `markFailed`.

## Provider-Agnostic Workflow

A workflow written against capability interfaces rather than concrete provider adapters. Provider-agnostic workflows are reusable across GitHub, GitLab, Jira, Bitbucket, and future providers when those providers satisfy the required capabilities.

## Agent Command

A stable Gateway-owned work item created when a workflow accepts a normalized event. An agent command has a durable command ID used for idempotency, retries, workflow runs, and mapping to produced artifacts such as branches or change requests. Workflow runners receive an `command` object as the main work item; avoid using `task` for this concept because task is overloaded with external systems such as Hermes Kanban.

## Command ID

The durable identity of an agent command. The same command ID must be reused when polling, webhooks, retries, or restarts observe the same requested work, so the Gateway does not create duplicate jobs or duplicate change requests.

## Change Request

A provider-neutral request to review and merge code changes. GitHub pull requests, GitLab merge requests, and Bitbucket pull requests are all change requests.

## Optional Provider Capability

A provider-specific capability that a workflow may use when present without making the workflow depend on that provider. Optional provider capabilities are discovered by name, such as `jira.transitions`, from a capability registry instead of by casting a generic capability to a concrete provider adapter.

## Capability Registry

A workflow-context object that exposes optional provider capabilities by name. The capability registry keeps base capability interfaces small while allowing workflows to opt into provider-specific behavior when available.

## Trust Policy

A Gateway-owned capability that decides whether an actor or target is allowed to trigger or receive agent work. A trust policy combines provider-derived facts, such as collaborator/member status or fork origin, with Gateway-owned configuration such as allowlists and workflow rules. The Gateway enforces baseline trust before workflow matching, and individual workflows may apply stricter trust checks.

## Enabled Target

An external repo, project, or work item scope that the Gateway is allowed to observe and act on. Provider token access is not enough; a target must be explicitly enabled in Gateway configuration.
