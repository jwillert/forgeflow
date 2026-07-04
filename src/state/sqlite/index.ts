import Database from "better-sqlite3"
import type { AgentCommand, AgentCommandStatus, ChangeRequestRef, ExecutionResult, NormalizedEvent } from "../../core/types.js"
import type { StateStore } from "../../core/state.js"

export function sqliteState(path: string): StateStore {
  return new SqliteState(path)
}

class SqliteState implements StateStore {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      create table if not exists cursors (
        source_key text primary key,
        cursor_json text,
        updated_at text not null
      );
      create table if not exists events (
        id text primary key,
        event_json text not null,
        raw_json text,
        processed_at text,
        created_at text not null
      );
      create table if not exists commands (
        id text primary key,
        command_json text not null,
        status text not null,
        defer_reason text,
        next_check_at text,
        updated_at text not null,
        created_at text not null
      );
      create table if not exists command_change_requests (
        command_id text primary key,
        ref_json text not null,
        updated_at text not null
      );
      create table if not exists workflow_runs (
        id integer primary key autoincrement,
        command_id text not null,
        workflow_id text not null,
        status text not null,
        started_at text,
        completed_at text,
        summary text,
        execution_json text,
        error text,
        created_at text not null
      );
    `)
  }

  async getCursor(sourceKey: string) {
    const row = this.db.prepare("select cursor_json from cursors where source_key = ?").get(sourceKey) as { cursor_json: string | null } | undefined
    return row?.cursor_json ? JSON.parse(row.cursor_json) : undefined
  }

  async setCursor(sourceKey: string, cursor?: { value?: string }) {
    this.db.prepare("insert into cursors(source_key, cursor_json, updated_at) values (?, ?, ?) on conflict(source_key) do update set cursor_json = excluded.cursor_json, updated_at = excluded.updated_at")
      .run(sourceKey, cursor ? JSON.stringify(cursor) : null, new Date().toISOString())
  }

  async hasProcessedEvent(eventId: string) {
    const row = this.db.prepare("select processed_at from events where id = ? and processed_at is not null").get(eventId)
    return !!row
  }

  async recordEvent(event: NormalizedEvent, options?: { rawPayload?: unknown }) {
    this.db.prepare("insert or ignore into events(id, event_json, raw_json, created_at) values (?, ?, ?, ?)")
      .run(event.id, JSON.stringify(event), options?.rawPayload ? JSON.stringify(options.rawPayload) : null, new Date().toISOString())
  }

  async markEventProcessed(eventId: string) {
    this.db.prepare("update events set processed_at = coalesce(processed_at, ?) where id = ?").run(new Date().toISOString(), eventId)
  }

  async hasCommand(commandId: string) {
    const row = this.db.prepare("select 1 from commands where id = ?").get(commandId)
    return !!row
  }

  async createCommand(command: AgentCommand) {
    this.db.prepare("insert into commands(id, command_json, status, defer_reason, next_check_at, updated_at, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(command.id, JSON.stringify(command), command.status, command.deferReason ?? null, command.nextCheckAt ?? null, command.updatedAt, command.createdAt)
  }

  async updateCommandStatus(commandId: string, status: AgentCommandStatus, input?: { reason?: string; nextCheckAt?: string }) {
    const row = this.db.prepare("select command_json from commands where id = ?").get(commandId) as { command_json: string } | undefined
    if (!row) return
    const command = JSON.parse(row.command_json) as AgentCommand
    command.status = status
    command.updatedAt = new Date().toISOString()
    if (input?.reason) command.deferReason = input.reason
    if (input?.nextCheckAt) command.nextCheckAt = input.nextCheckAt
    this.db.prepare("update commands set command_json = ?, status = ?, defer_reason = ?, next_check_at = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(command), status, command.deferReason ?? null, command.nextCheckAt ?? null, command.updatedAt, commandId)
  }

  async getCommand(commandId: string) {
    const row = this.db.prepare("select command_json from commands where id = ?").get(commandId) as { command_json: string } | undefined
    return row ? JSON.parse(row.command_json) as AgentCommand : undefined
  }

  async findLatestFailedCommandForTarget(targetKey: string) {
    const rows = this.db.prepare("select command_json from commands where status = 'failed' order by updated_at desc").all() as Array<{ command_json: string }>
    return rows.map(r => JSON.parse(r.command_json) as AgentCommand).find(c => `${c.workTarget.provider}:${c.workTarget.repo ?? c.workTarget.project ?? ""}:${c.workTarget.kind}:${c.workTarget.id}` === targetKey)
  }

  async listDueDeferred(now: string, limit: number) {
    const rows = this.db.prepare("select command_json from commands where status = 'deferred' and (next_check_at is null or next_check_at <= ?) order by created_at asc limit ?").all(now, limit) as Array<{ command_json: string }>
    return rows.map(r => JSON.parse(r.command_json) as AgentCommand)
  }

  async claimQueued(limit: number) {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare("select id, command_json from commands where status = 'queued' order by created_at asc limit ?").all(limit) as Array<{ id: string; command_json: string }>
      const now = new Date().toISOString()
      for (const row of rows) {
        const command = JSON.parse(row.command_json) as AgentCommand
        command.status = "running"
        command.updatedAt = now
        this.db.prepare("update commands set command_json = ?, status = 'running', updated_at = ? where id = ? and status = 'queued'").run(JSON.stringify(command), now, row.id)
      }
      return rows.map(r => JSON.parse(r.command_json) as AgentCommand)
    })
    return tx()
  }

  async getLinkedChangeRequest(commandId: string) {
    const row = this.db.prepare("select ref_json from command_change_requests where command_id = ?").get(commandId) as { ref_json: string } | undefined
    return row ? JSON.parse(row.ref_json) as ChangeRequestRef : undefined
  }

  async linkChangeRequest(commandId: string, ref: ChangeRequestRef) {
    this.db.prepare("insert into command_change_requests(command_id, ref_json, updated_at) values (?, ?, ?) on conflict(command_id) do update set ref_json = excluded.ref_json, updated_at = excluded.updated_at")
      .run(commandId, JSON.stringify(ref), new Date().toISOString())
  }

  async getLastExecutionResult(commandId: string) {
    const row = this.db.prepare("select execution_json from workflow_runs where command_id = ? and execution_json is not null order by id desc limit 1").get(commandId) as { execution_json: string } | undefined
    return row ? JSON.parse(row.execution_json) as ExecutionResult : undefined
  }

  async recordWorkflowRun(input: { commandId: string; workflowId: string; status: "running" | "succeeded" | "failed"; startedAt?: string; completedAt?: string; summary?: string; execution?: ExecutionResult; error?: string }) {
    this.db.prepare("insert into workflow_runs(command_id, workflow_id, status, started_at, completed_at, summary, execution_json, error, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.commandId, input.workflowId, input.status, input.startedAt ?? null, input.completedAt ?? null, input.summary ?? null, input.execution ? JSON.stringify(input.execution) : null, input.error ?? null, new Date().toISOString())
  }
}
