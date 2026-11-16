import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { versionOf } from './versioning.js';

/**
 * Persistent, resumable local task queue. Jobs survive a browser refresh; after
 * a server restart any job that was mid-flight is marked `interrupted` and can
 * be re-queued with its original payload. Only one CPU-heavy job runs at once
 * so the single-threaded process stays responsive.
 */

const TASK_FILE = path.join('var', 'tasks.json');
const MAX_TASKS = 60;

export class TaskQueue {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.file = path.join(root, TASK_FILE);
    this.tasks = [];
    this.running = null;
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        this.tasks = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        this.tasks = [];
      }
    }
    let recovered = 0;
    for (const t of this.tasks) {
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'interrupted';
        t.message = '服务重启，任务已中断；可恢复并重新排队。';
        t.finishedAt = t.finishedAt ?? new Date().toISOString();
        recovered += 1;
      }
    }
    if (recovered) this.persist();
    this.pump();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(-MAX_TASKS);
    fs.writeFileSync(this.file, JSON.stringify(this.tasks, null, 2) + '\n');
  }

  enqueue(kind, payload, { label = '' } = {}) {
    if (!this.handlers[kind]) throw Object.assign(new Error(`未知任务类型：${kind}`), { status: 400 });
    const now = new Date().toISOString();
    const task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      kind,
      label,
      payload,
      status: 'queued',
      progress: 0,
      message: '排队中',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      resultVersionKey: null,
      resultRef: null,
      error: null,
      attempts: 0,
    };
    this.tasks.push(task);
    this.persist();
    this.pump();
    return task;
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  list() {
    return [...this.tasks].reverse();
  }

  retry(id) {
    const t = this.get(id);
    if (!t) return null;
    if (t.status === 'running' || t.status === 'queued') {
      throw Object.assign(new Error('任务仍在运行'), { status: 409 });
    }
    t.status = 'queued';
    t.progress = 0;
    t.message = '重新排队';
    t.error = null;
    t.finishedAt = null;
    t.resultRef = null;
    t.resultVersionKey = null;
    this.persist();
    this.pump();
    return t;
  }

  cancel(id) {
    const t = this.get(id);
    if (!t) return null;
    if (t.status === 'queued') {
      t.status = 'cancelled';
      t.message = '已取消';
      t.finishedAt = new Date().toISOString();
      this.persist();
    }
    return t;
  }

  update(id, patch) {
    const t = this.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.persist();
  }

  pump() {
    if (this.running) return;
    const next = this.tasks.find((t) => t.status === 'queued');
    if (!next) return;
    this.running = next;
    next.status = 'running';
    next.startedAt = new Date().toISOString();
    next.attempts += 1;
    next.message = '运行中';
    this.persist();
    const handler = this.handlers[next.kind];
    Promise.resolve()
      .then(() => handler(next.payload, (progress, message) => this.update(next.id, { progress, message })))
      .then((result) => {
        next.status = 'done';
        next.progress = 1;
        next.message = '完成';
        next.finishedAt = new Date().toISOString();
        next.result = result?.result ?? null;
        next.resultRef = result?.ref ?? null;
        next.resultVersionKey = result?.versionKey ?? null;
        next.error = null;
      })
      .catch((err) => {
        next.status = 'error';
        next.message = '失败';
        next.finishedAt = new Date().toISOString();
        next.error = String(err?.stack ?? err?.message ?? err).slice(0, 4000);
      })
      .finally(() => {
        this.running = null;
        this.persist();
        setImmediate(() => this.pump());
      });
  }
}

export function taskInputSignature(payload) {
  return versionOf(payload, 'req', 12);
}
