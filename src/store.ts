import { Redis } from "ioredis";
import type { Comment, CommentRole, CommentStatus, UserRecord } from "./types";

/**
 * Comment storage abstraction.
 *
 * Two implementations:
 *   - RedisCommentsStore (ioredis — works against any Redis-protocol server,
 *     e.g. Railway's managed Redis service, self-hosted Redis, etc.)
 *   - MemoryCommentsStore (in-process Map, fallback for local dev)
 *
 * `getStore()` picks based on `REDIS_URL`. If unset, falls back to memory
 * so local dev works before any Redis is wired up.
 *
 * Memory is per-process — every `next dev` reload wipes it. For
 * persistent dev data, point `REDIS_URL` at a local Redis or your
 * staging Redis instance.
 */

export interface CommentsStore {
  list(deckId: string, slideId?: string): Promise<Comment[]>;
  /** Single-comment fetch — needed for ownership checks before edit/delete. */
  get(deckId: string, commentId: string): Promise<Comment | null>;
  create(comment: Comment): Promise<Comment>;
  setStatus(deckId: string, commentId: string, status: CommentStatus, resolverEmail?: string): Promise<Comment | null>;
  /** Replace a comment's body (and its derived mentions). Stamps editedAt. */
  updateBody(
    deckId: string,
    commentId: string,
    body: string,
    mentions: string[]
  ): Promise<Comment | null>;
  /** Hard delete a comment and remove it from the indexes. */
  delete(deckId: string, commentId: string): Promise<boolean>;
  /** Read the per-deck user record (role assignment). null if not set. */
  getUser(deckId: string, email: string): Promise<UserRecord | null>;
  /** Create or update the user record for a deck. */
  setUser(deckId: string, email: string, role: CommentRole, name?: string): Promise<UserRecord>;
  /** Every user who has signed in + picked a role for this deck. Used by the @mention typeahead. */
  listUsers(deckId: string): Promise<UserRecord[]>;
  /**
   * Slide-order overlay. When set, the host renders slides in this
   * order (by id) instead of source order. Producers reorder via
   * the chrome's outline view; the overlay lives until the creative
   * either bakes it into source or clears it.
   *
   * Returns null if no overlay is set — the host falls back to source.
   */
  getReorder(deckId: string): Promise<string[] | null>;
  setReorder(deckId: string, slideIds: string[]): Promise<void>;
  clearReorder(deckId: string): Promise<void>;
  /**
   * Toggle a comment's "queued for implementation" flag. Set on the
   * comment record itself AND maintained in a side-index set so the
   * queue can be listed without scanning every comment. Idempotent —
   * setting `queued=true` on an already-queued comment is a no-op.
   *
   * Returns the updated comment, or null if the comment doesn't exist.
   */
  setQueued(
    deckId: string,
    commentId: string,
    queued: boolean
  ): Promise<Comment | null>;
  /**
   * Every comment currently in the implementation queue, sorted oldest
   * first. The compile-prompt button reads this and concatenates the
   * bodies for the Claude handoff.
   */
  listQueued(deckId: string): Promise<Comment[]>;
  /**
   * Published deck content snapshot.
   *
   * The creative's "Publish" action serializes the host's current
   * `deckContent` and writes it here. The production view reads from
   * this snapshot; the staging view always reads live from
   * `deck.content.ts`. This is the deck-level publish gate, separate
   * from the per-slide status overlay.
   *
   * Content is stored as opaque JSON — chrome doesn't validate the
   * shape because `DeckContent` is a host-defined type. Hosts cast
   * back to `DeckContent` when reading.
   *
   * Returns null when no snapshot has ever been published (production
   * falls back to source in that case).
   */
  getPublishedContent(deckId: string): Promise<PublishedContent | null>;
  setPublishedContent(
    deckId: string,
    content: unknown,
    publishedBy: string
  ): Promise<PublishedContent>;
}

/** Envelope around a published snapshot. */
export interface PublishedContent {
  /** The frozen DeckContent blob — opaque to chrome, cast by the host. */
  content: unknown;
  /** ISO 8601 timestamp of when this snapshot was taken. */
  publishedAt: string;
  /** Email of the creative who hit the Publish button. */
  publishedBy: string;
}

// ─── Keys ──────────────────────────────────────────────────────────────
//
// Layout in Redis:
//   comments:{deckId}                     → SET of comment ids
//   comments:{deckId}:by-slide:{slideId}  → SET of comment ids
//   comments:{deckId}:item:{commentId}    → JSON blob for one comment
//
// `list` reads the by-slide set when slideId is given, else the full
// set. Both fan out to MGET on the item keys.

const k = {
  all: (deckId: string) => `comments:${deckId}`,
  bySlide: (deckId: string, slideId: string) =>
    `comments:${deckId}:by-slide:${slideId}`,
  item: (deckId: string, id: string) => `comments:${deckId}:item:${id}`,
  user: (deckId: string, email: string) =>
    `comments:${deckId}:user:${email.toLowerCase()}`,
  /** SET of all user emails for a deck — populated on setUser, scanned by listUsers. */
  users: (deckId: string) => `comments:${deckId}:users`,
  /** STRING (JSON) — array of slide ids in producer-defined order, or unset. */
  reorder: (deckId: string) => `comments:${deckId}:reorder`,
  /** STRING (JSON) — published deck snapshot envelope, or unset. */
  published: (deckId: string) => `comments:${deckId}:published`,
  /** SET of comment ids the creative has triaged into the "implement next" queue. */
  queued: (deckId: string) => `comments:${deckId}:queued`,
};

// ─── JSON helpers ─────────────────────────────────────────────────────
//
// ioredis returns raw strings — unlike `@upstash/redis`, it does NOT
// auto-deserialize JSON. We stringify on every `set` of a complex value
// and parse on every `get`. Defensive: if parse fails, return null
// rather than crash (corrupt entry shouldn't take down the panel).

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── Redis implementation ─────────────────────────────────────────────

class RedisCommentsStore implements CommentsStore {
  constructor(private redis: Redis) {}

  async list(deckId: string, slideId?: string): Promise<Comment[]> {
    const setKey = slideId ? k.bySlide(deckId, slideId) : k.all(deckId);
    const ids = await this.redis.smembers(setKey);
    if (ids.length === 0) return [];
    const itemKeys = ids.map((id) => k.item(deckId, id));
    const blobs = await this.redis.mget(...itemKeys);
    return blobs
      .map((b) => parseJson<Comment>(b))
      .filter((c): c is Comment => c !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(comment: Comment): Promise<Comment> {
    const pipeline = this.redis.pipeline();
    pipeline.set(k.item(comment.deckId, comment.id), JSON.stringify(comment));
    pipeline.sadd(k.all(comment.deckId), comment.id);
    pipeline.sadd(k.bySlide(comment.deckId, comment.slideId), comment.id);
    await pipeline.exec();
    return comment;
  }

  async setStatus(
    deckId: string,
    commentId: string,
    status: CommentStatus,
    resolverEmail?: string
  ): Promise<Comment | null> {
    const existing = parseJson<Comment>(
      await this.redis.get(k.item(deckId, commentId))
    );
    if (!existing) return null;
    const updated: Comment = {
      ...existing,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : undefined,
      resolvedBy: status === "resolved" ? resolverEmail : undefined,
    };
    await this.redis.set(k.item(deckId, commentId), JSON.stringify(updated));
    return updated;
  }

  async get(deckId: string, commentId: string): Promise<Comment | null> {
    return parseJson<Comment>(
      await this.redis.get(k.item(deckId, commentId))
    );
  }

  async updateBody(
    deckId: string,
    commentId: string,
    body: string,
    mentions: string[]
  ): Promise<Comment | null> {
    const existing = parseJson<Comment>(
      await this.redis.get(k.item(deckId, commentId))
    );
    if (!existing) return null;
    const updated: Comment = {
      ...existing,
      body,
      editedAt: new Date().toISOString(),
      ...(mentions.length > 0 ? { mentions } : { mentions: undefined }),
    };
    await this.redis.set(k.item(deckId, commentId), JSON.stringify(updated));
    return updated;
  }

  async delete(deckId: string, commentId: string): Promise<boolean> {
    const existing = parseJson<Comment>(
      await this.redis.get(k.item(deckId, commentId))
    );
    if (!existing) return false;
    const pipeline = this.redis.pipeline();
    pipeline.del(k.item(deckId, commentId));
    pipeline.srem(k.all(deckId), commentId);
    pipeline.srem(k.bySlide(deckId, existing.slideId), commentId);
    // Defensive: also drop from the queue index so a deleted comment
    // never re-surfaces in the "send to Claude" compile.
    pipeline.srem(k.queued(deckId), commentId);
    await pipeline.exec();
    return true;
  }

  async getUser(deckId: string, email: string): Promise<UserRecord | null> {
    return parseJson<UserRecord>(
      await this.redis.get(k.user(deckId, email))
    );
  }

  async setUser(
    deckId: string,
    email: string,
    role: CommentRole,
    name?: string
  ): Promise<UserRecord> {
    const existing = await this.getUser(deckId, email);
    const record: UserRecord = {
      email: email.toLowerCase(),
      role,
      name: name ?? existing?.name,
      firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
    };
    const pipeline = this.redis.pipeline();
    pipeline.set(k.user(deckId, email), JSON.stringify(record));
    pipeline.sadd(k.users(deckId), record.email);
    await pipeline.exec();
    return record;
  }

  async listUsers(deckId: string): Promise<UserRecord[]> {
    const emails = await this.redis.smembers(k.users(deckId));
    if (emails.length === 0) return [];
    const keys = emails.map((e) => k.user(deckId, e));
    const blobs = await this.redis.mget(...keys);
    return blobs
      .map((b) => parseJson<UserRecord>(b))
      .filter((r): r is UserRecord => r !== null);
  }

  async getReorder(deckId: string): Promise<string[] | null> {
    const raw = await this.redis.get(k.reorder(deckId));
    const parsed = parseJson<string[]>(raw);
    return Array.isArray(parsed) ? parsed : null;
  }

  async setReorder(deckId: string, slideIds: string[]): Promise<void> {
    await this.redis.set(k.reorder(deckId), JSON.stringify(slideIds));
  }

  async clearReorder(deckId: string): Promise<void> {
    await this.redis.del(k.reorder(deckId));
  }

  async getPublishedContent(
    deckId: string
  ): Promise<PublishedContent | null> {
    return parseJson<PublishedContent>(
      await this.redis.get(k.published(deckId))
    );
  }

  async setPublishedContent(
    deckId: string,
    content: unknown,
    publishedBy: string
  ): Promise<PublishedContent> {
    const payload: PublishedContent = {
      content,
      publishedAt: new Date().toISOString(),
      publishedBy,
    };
    await this.redis.set(k.published(deckId), JSON.stringify(payload));
    return payload;
  }

  async setQueued(
    deckId: string,
    commentId: string,
    queued: boolean
  ): Promise<Comment | null> {
    const existing = parseJson<Comment>(
      await this.redis.get(k.item(deckId, commentId))
    );
    if (!existing) return null;
    const updated: Comment = { ...existing, queued };

    const pipeline = this.redis.pipeline();
    pipeline.set(k.item(deckId, commentId), JSON.stringify(updated));
    if (queued) {
      pipeline.sadd(k.queued(deckId), commentId);
    } else {
      pipeline.srem(k.queued(deckId), commentId);
    }
    await pipeline.exec();
    return updated;
  }

  async listQueued(deckId: string): Promise<Comment[]> {
    const ids = await this.redis.smembers(k.queued(deckId));
    if (ids.length === 0) return [];
    const itemKeys = ids.map((id) => k.item(deckId, id));
    const blobs = await this.redis.mget(...itemKeys);
    return blobs
      .map((b) => parseJson<Comment>(b))
      .filter((c): c is Comment => c !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

// ─── Memory implementation ─────────────────────────────────────────────

class MemoryCommentsStore implements CommentsStore {
  private comments = new Map<string, Comment>();
  private users = new Map<string, UserRecord>();
  private reorders = new Map<string, string[]>();

  private key(deckId: string, id: string) {
    return `${deckId}:${id}`;
  }

  private userKey(deckId: string, email: string) {
    return `${deckId}:${email.toLowerCase()}`;
  }

  async list(deckId: string, slideId?: string): Promise<Comment[]> {
    const all = Array.from(this.comments.values()).filter(
      (c) => c.deckId === deckId && (!slideId || c.slideId === slideId)
    );
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(comment: Comment): Promise<Comment> {
    this.comments.set(this.key(comment.deckId, comment.id), comment);
    return comment;
  }

  async setStatus(
    deckId: string,
    commentId: string,
    status: CommentStatus,
    resolverEmail?: string
  ): Promise<Comment | null> {
    const existing = this.comments.get(this.key(deckId, commentId));
    if (!existing) return null;
    const updated: Comment = {
      ...existing,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : undefined,
      resolvedBy: status === "resolved" ? resolverEmail : undefined,
    };
    this.comments.set(this.key(deckId, commentId), updated);
    return updated;
  }

  async get(deckId: string, commentId: string): Promise<Comment | null> {
    return this.comments.get(this.key(deckId, commentId)) ?? null;
  }

  async updateBody(
    deckId: string,
    commentId: string,
    body: string,
    mentions: string[]
  ): Promise<Comment | null> {
    const existing = this.comments.get(this.key(deckId, commentId));
    if (!existing) return null;
    const updated: Comment = {
      ...existing,
      body,
      editedAt: new Date().toISOString(),
      ...(mentions.length > 0 ? { mentions } : { mentions: undefined }),
    };
    this.comments.set(this.key(deckId, commentId), updated);
    return updated;
  }

  async delete(deckId: string, commentId: string): Promise<boolean> {
    const existing = this.comments.get(this.key(deckId, commentId));
    if (!existing) return false;
    this.comments.delete(this.key(deckId, commentId));
    return true;
  }

  async getUser(deckId: string, email: string): Promise<UserRecord | null> {
    return this.users.get(this.userKey(deckId, email)) ?? null;
  }

  async setUser(
    deckId: string,
    email: string,
    role: CommentRole,
    name?: string
  ): Promise<UserRecord> {
    const existing = await this.getUser(deckId, email);
    const record: UserRecord = {
      email: email.toLowerCase(),
      role,
      name: name ?? existing?.name,
      firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
    };
    this.users.set(this.userKey(deckId, email), record);
    return record;
  }

  async listUsers(deckId: string): Promise<UserRecord[]> {
    const prefix = `${deckId}:`;
    return Array.from(this.users.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }

  async getReorder(deckId: string): Promise<string[] | null> {
    return this.reorders.get(deckId) ?? null;
  }

  async setReorder(deckId: string, slideIds: string[]): Promise<void> {
    this.reorders.set(deckId, [...slideIds]);
  }

  async clearReorder(deckId: string): Promise<void> {
    this.reorders.delete(deckId);
  }

  private publishedSnapshots = new Map<string, PublishedContent>();

  async getPublishedContent(
    deckId: string
  ): Promise<PublishedContent | null> {
    return this.publishedSnapshots.get(deckId) ?? null;
  }

  async setPublishedContent(
    deckId: string,
    content: unknown,
    publishedBy: string
  ): Promise<PublishedContent> {
    const payload: PublishedContent = {
      content,
      publishedAt: new Date().toISOString(),
      publishedBy,
    };
    this.publishedSnapshots.set(deckId, payload);
    return payload;
  }

  async setQueued(
    deckId: string,
    commentId: string,
    queued: boolean
  ): Promise<Comment | null> {
    const existing = this.comments.get(this.key(deckId, commentId));
    if (!existing) return null;
    const updated: Comment = { ...existing, queued };
    this.comments.set(this.key(deckId, commentId), updated);
    return updated;
  }

  async listQueued(deckId: string): Promise<Comment[]> {
    return Array.from(this.comments.values())
      .filter((c) => c.deckId === deckId && c.queued)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

// ─── Pick implementation ───────────────────────────────────────────────
//
// Singleton pattern via globalThis so HMR doesn't leak connections.
// In Next.js dev, modules can be reloaded while the Node process keeps
// running — without this, each reload would open a fresh Redis socket
// and never close the old ones, eventually exhausting the connection
// pool. globalThis survives module hot-reloads (it's the actual JS
// global), so the singleton sticks around across edits.

const globalForRedis = globalThis as unknown as {
  __pitchcraft_redis?: Redis;
  __pitchcraft_store?: CommentsStore;
};

export function getStore(): CommentsStore {
  if (globalForRedis.__pitchcraft_store) return globalForRedis.__pitchcraft_store;

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    if (!globalForRedis.__pitchcraft_redis) {
      // ioredis options chosen for production resilience:
      //  - lazyConnect: don't dial on construction; first command opens.
      //    Avoids hangs at module load if Redis is briefly unavailable.
      //  - maxRetriesPerRequest: cap retries so a dead Redis doesn't
      //    pile up indefinitely-blocked promises.
      globalForRedis.__pitchcraft_redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
    }
    globalForRedis.__pitchcraft_store = new RedisCommentsStore(
      globalForRedis.__pitchcraft_redis
    );
  } else {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[comments] REDIS_URL not set in production — falling back to in-memory store. Comments will not persist across deployments."
      );
    }
    globalForRedis.__pitchcraft_store = new MemoryCommentsStore();
  }

  return globalForRedis.__pitchcraft_store;
}
