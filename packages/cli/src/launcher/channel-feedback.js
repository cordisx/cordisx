import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_FEEDBACK = Object.freeze({
    reaction: Object.freeze({ enabled: true, emojiType: 'OnIt' }),
    wait: Object.freeze({ enabled: true, delaySeconds: 30, text: '已收到，正在处理，请稍候。' }),
});

const listeners = new Set();
const sameAccount = (left, right) => left && right
    && ['adapterId', 'accountId', 'tenantId'].every(key => left[key] === right[key]);
const sameDestination = (event, target) => sameAccount(event, target)
    && (event.conversationId === target.conversationId
        || event.kind === 'direct' && event.actor?.userId === target.conversationId);

// Broadcast an intended outbound effect before it reaches the transport. This is
// deliberately conservative: an uncertain/failed reply suppresses a reminder.
export function channelFeedbackOutbound(target) {
    for (const listener of listeners) {
        try { listener(target); } catch { /* feedback must not affect delivery */ }
    }
}

export function instrumentFeedbackRuntime(runtime) {
    for (const name of ['notifyOnce', 'notifyQuestionOnce']) {
        const original = runtime[name];
        if (typeof original !== 'function') continue;
        runtime[name] = function (notification, ...args) {
            channelFeedbackOutbound(notification?.target);
            return original.call(this, notification, ...args);
        };
    }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validWaitText = value => typeof value === 'string' && Boolean(value.trim())
    && value.length <= 1000 && !/\0/u.test(value);
function exact(value, keys) {
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw new Error('INVALID_FEEDBACK_CONFIG');
}

/** Read a profile-local file for every new task and again at the deadline. */
export async function readFeedbackSettings(home) {
    if (!home || !path.isAbsolute(home)) throw new Error('INVALID_FEEDBACK_HOME');
    let value;
    try {
        value = JSON.parse(await readFile(path.join(home, 'channel-feedback.json'), 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return DEFAULT_FEEDBACK;
        throw new Error('INVALID_FEEDBACK_CONFIG');
    }
    exact(value, ['reaction', 'wait']);
    const reaction = value.reaction ?? {}, wait = value.wait ?? {};
    exact(reaction, ['enabled', 'emojiType', 'completionEmojiType']);
    exact(wait, ['enabled', 'delaySeconds', 'text', 'texts']);
    const result = {
        reaction: { ...DEFAULT_FEEDBACK.reaction, ...reaction },
        wait: { ...DEFAULT_FEEDBACK.wait, ...wait },
    };
    if (typeof result.reaction.enabled !== 'boolean'
        || typeof result.reaction.emojiType !== 'string'
        || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.emojiType)
        || result.reaction.completionEmojiType !== undefined && !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.completionEmojiType)
        || typeof result.wait.enabled !== 'boolean'
        || !Number.isSafeInteger(result.wait.delaySeconds)
        || result.wait.delaySeconds < 1 || result.wait.delaySeconds > 86400
        || !validWaitText(result.wait.text)
        || result.wait.texts !== undefined && (!Array.isArray(result.wait.texts)
            || result.wait.texts.length < 1 || result.wait.texts.length > 50
            || !result.wait.texts.every(validWaitText)))
        throw new Error('INVALID_FEEDBACK_CONFIG');
    return result;
}

/** Narrow access to the SDK already owned by the current account/generation. */
export function createFeedbackSdkAccess(channelFor, current) {
    const resolve = event => {
        if (!current() || !['feishu', 'lark'].includes(event.adapterId))
            throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE');
        const channel = channelFor(event);
        if (!channel?.rawClient || !current() || channelFor(event) !== channel)
            throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE');
        return channel.rawClient;
    };
    const owned = new Map();
    const identity = event => JSON.stringify([event.adapterId, event.accountId, event.tenantId, event.conversationId, event.messageId]);
    return {
        react: async (event, emojiType) => {
            if (typeof event.messageId !== 'string' || !event.messageId)
                throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE');
            const client = resolve(event);
            const result = await client.im.v1.messageReaction.create({
                path: { message_id: event.messageId },
                data: { reaction_type: { emoji_type: emojiType } },
            });
            if (result?.code != null && result.code !== 0)
                throw new Error('CHANNEL_FEEDBACK_REACTION_FAILED');
            const reactionId = result?.data?.reaction_id;
            if (!reactionId) throw new Error('CHANNEL_FEEDBACK_REACTION_UNKNOWN');
            owned.set(reactionId, identity(event));
            return { reactionId, emojiType };
        },
        remove: async (event, reactionId) => {
            if (owned.get(reactionId) !== identity(event)) throw new Error('CHANNEL_REACTION_NOT_OWNED');
            const result = await resolve(event).im.v1.messageReaction.delete({
                path: { message_id: event.messageId, reaction_id: reactionId },
            });
            if (result?.code !== 0) throw new Error('CHANNEL_FEEDBACK_REACTION_UNKNOWN');
            owned.delete(reactionId);
            return { reactionId, removed: true };
        },
        wait: async (event, target, text, recordId) => {
            if (!sameAccount(event, target) || target.conversationId !== event.conversationId)
                throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE');
            const client = resolve(event);
            const uuid = createHash('sha256').update(`channel-feedback:${recordId}`).digest('hex').slice(0, 32);
            const content = JSON.stringify({ text });
            const response = target.semantics === 'conversation'
                ? await client.im.v1.message.create({
                    params: { receive_id_type: target.conversationId.startsWith('ou_') ? 'open_id' : 'chat_id' },
                    data: { receive_id: target.conversationId, msg_type: 'text', content, uuid },
                })
                : await client.im.v1.message.reply({
                    path: { message_id: target.threadId },
                    data: { msg_type: 'text', content, uuid, reply_in_thread: target.semantics === 'topic' },
                });
            if (response?.code !== 0 || !response.data?.message_id)
                throw new Error('CHANNEL_FEEDBACK_WAIT_FAILED');
        },
    };
}

/** One local, at-most-once acknowledgement and reminder per routed input. */
export class ChannelFeedback {
    constructor(options) {
        this.store = options.store;
        this.access = options.access;
        this.turnState = options.turnState;
        this.allows = options.allows;
        this.replyDefaults = options.replyDefaults;
        this.replyTarget = options.replyTarget;
        this.signal = options.signal;
        this.report = options.report;
        this.settings = options.settings ?? (() => readFeedbackSettings(process.env.CORDISX_HOME));
        this.randomIndex = options.randomIndex ?? (length => randomInt(length));
        this.now = options.now ?? Date.now;
        this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
        this.cancel = options.cancel ?? clearTimeout;
        this.pending = new Map();
        this.disposed = false;
        this.observer = target => this.outbound(target);
        listeners.add(this.observer);
    }
    diagnostic(code) {
        try { this.report?.(code); } catch { /* keep the task independent */ }
    }
    permitted(state, event) {
        try {
            return state.policy.enabled && this.allows(state.policy, 'dispatch', event)
                && this.allows(state.policy, 'send', event);
        } catch { return false; }
    }
    jobs(state, recordId) {
        return Object.values(state.jobs).filter(job => job.recordId === recordId
            && ['queued', 'dispatching', 'running'].includes(job.state)
            && (job.bindingId === undefined || state.bindings[job.bindingId]?.state === 'active'));
    }
    alive(entry) {
        return !this.disposed && !this.signal?.aborted && !entry.replied
            && this.pending.get(entry.recordId) === entry;
    }
    finish(entry) {
        if (entry.timer !== undefined) this.cancel(entry.timer);
        entry.timer = undefined;
        if (this.pending.get(entry.recordId) === entry) this.pending.delete(entry.recordId);
    }
    arm(entry, delay) {
        if (!this.alive(entry)) return;
        if (entry.timer !== undefined) this.cancel(entry.timer);
        entry.timer = this.schedule(() => {
            entry.timer = undefined;
            void this.deadline(entry).catch(() => {
                this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED');
                this.finish(entry);
            });
        }, Math.max(0, delay));
        entry.timer?.unref?.();
    }
    async routed(recordId) {
        if (this.disposed || this.signal?.aborted || this.pending.has(recordId)) return;
        const snapshot = this.store.snapshot(), record = snapshot.inputs[recordId];
        const event = record?.input?.source?.event;
        if (!event || !['feishu', 'lark'].includes(event.adapterId)
            || !this.jobs(snapshot, recordId).length || !this.permitted(snapshot, event)) return;
        const entry = { recordId, event, since: this.now(), replied: false, timer: undefined };
        this.pending.set(recordId, entry);
        let fresh;
        try {
            fresh = await this.store.mutate(state => {
                const input = state.inputs[recordId];
                if (!input || input.feedback || !this.jobs(state, recordId).length
                    || !this.permitted(state, event)) return false;
                // Reservation precedes any SDK effect. A restarted process does
                // not replay feedback for an already reserved input.
                input.feedback = { since: entry.since, reactionAttempted: true, waitAttempted: false, replyObserved: false };
                return true;
            });
        } catch {
            this.finish(entry);
            this.diagnostic('CHANNEL_FEEDBACK_STORE_UNAVAILABLE');
            return;
        }
        if (!fresh || !this.alive(entry)) { this.finish(entry); return; }
        let config;
        try { config = await this.settings(); }
        catch { this.diagnostic('CHANNEL_FEEDBACK_CONFIG_INVALID'); this.finish(entry); return; }
        if (!this.alive(entry)) return;
        const latest = this.store.snapshot();
        if (!this.jobs(latest, recordId).length || !this.permitted(latest, event)) {
            this.finish(entry);
            return;
        }
        if (config.reaction.enabled) {
            try {
                const operation = this.access()?.feedbackReact?.(event, config.reaction.emojiType);
                if (operation) void Promise.resolve(operation).then(receipt => this.store.mutate(state => {
                    const feedback = state.inputs[recordId]?.feedback;
                    if (feedback) feedback.reaction = receipt;
                })).catch(() => this.diagnostic('CHANNEL_FEEDBACK_REACTION_FAILED'));
                else this.diagnostic('CHANNEL_FEEDBACK_REACTION_FAILED');
            } catch { this.diagnostic('CHANNEL_FEEDBACK_REACTION_FAILED'); }
        }
        if (config.wait.enabled && this.alive(entry))
            this.arm(entry, entry.since + config.wait.delaySeconds * 1000 - this.now());
        else this.finish(entry);
    }
    outbound(target) {
        if (this.disposed) return;
        for (const entry of this.pending.values()) {
            if (!sameDestination(entry.event, target)) continue;
            entry.replied = true;
            this.finish(entry);
            // Best-effort durable evidence; in-memory fencing is synchronous.
            void this.store.mutate(state => {
                const feedback = state.inputs[entry.recordId]?.feedback;
                if (feedback) feedback.replyObserved = true;
            }).catch(() => this.diagnostic('CHANNEL_FEEDBACK_STORE_UNAVAILABLE'));
        }
    }
    jobUpdated(recordId) {
        const entry = this.pending.get(recordId);
        if (!entry) return;
        const state = this.store.snapshot();
        if (!this.jobs(state, recordId).length || !this.permitted(state, entry.event)) this.finish(entry);
    }
    async completed(recordId) {
        const state = this.store.snapshot(), record = state.inputs[recordId];
        const jobs = Object.values(state.jobs).filter(job => job.recordId === recordId);
        if (!record?.feedback?.reaction || record.feedback.completionAttempted || !jobs.length
            || jobs.some(job => job.state !== 'completed') || !this.permitted(state, record.input.source.event)) return;
        const config = await this.settings();
        const emoji = config.reaction.completionEmojiType;
        if (!config.reaction.enabled || !emoji || !/^[A-Za-z0-9_]{1,64}$/u.test(emoji)) return;
        const reserved = await this.store.mutate(state => {
            const feedback = state.inputs[recordId]?.feedback;
            if (!feedback || feedback.completionAttempted) return false;
            feedback.completionAttempted = true;
            return true;
        });
        if (!reserved) return;
        const access = this.access(), event = record.input.source.event;
        if (!access?.feedbackRemove || !access.feedbackReact) throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE');
        await access.feedbackRemove(event, record.feedback.reaction.reactionId);
        const receipt = await access.feedbackReact(event, emoji);
        if (receipt) await this.store.mutate(state => { state.inputs[recordId].feedback.completion = receipt; });
    }
    async activeJob(entry) {
        if (!this.alive(entry)) return { state: 'finished' };
        const state = this.store.snapshot();
        if (!this.permitted(state, entry.event)) return { state: 'finished' };
        const jobs = this.jobs(state, entry.recordId);
        let queued, unknown = false;
        for (const job of jobs) {
            if (job.state === 'queued') { queued ??= job; continue; }
            if (job.state !== 'running' || !job.sessionId || !job.turnId) { unknown = true; continue; }
            const takeover = state.liveTakeovers?.[job.sessionId];
            if (takeover && !['preparing', 'ready', 'abandoned'].includes(takeover.state)) {
                unknown = true;
                continue;
            }
            let observed = 'unknown';
            try { observed = await this.turnState(job.sessionId, job.turnId); } catch { /* fail closed */ }
            if (!this.alive(entry)) return { state: 'finished' };
            if (observed === 'active') return { state: 'active', job };
            if (observed === 'unknown') unknown = true;
        }
        if (unknown) return { state: 'unknown' };
        return queued ? { state: 'active', job: queued } : { state: 'finished' };
    }
    async deadline(entry) {
        if (!this.alive(entry)) return;
        let config;
        try { config = await this.settings(); }
        catch { this.diagnostic('CHANNEL_FEEDBACK_CONFIG_INVALID'); this.finish(entry); return; }
        if (!this.alive(entry)) return;
        if (!config.wait.enabled) { this.finish(entry); return; }
        const remaining = entry.since + config.wait.delaySeconds * 1000 - this.now();
        if (remaining > 0) { this.arm(entry, remaining); return; }
        const observed = await this.activeJob(entry);
        if (!this.alive(entry)) return;
        if (observed.state === 'unknown') {
            if (this.now() - entry.since <= config.wait.delaySeconds * 1000 + 120000) this.arm(entry, 2000);
            else this.finish(entry);
            return;
        }
        if (observed.state !== 'active') { this.finish(entry); return; }
        const reserved = await this.store.mutate(state => {
            const feedback = state.inputs[entry.recordId]?.feedback;
            const job = state.jobs[observed.job.id];
            if (!feedback || feedback.waitAttempted || feedback.replyObserved || !job
                || job.state !== observed.job.state || job.sessionId !== observed.job.sessionId
                || job.turnId !== observed.job.turnId || !this.jobs(state, entry.recordId).some(item => item.id === job.id)
                || !this.permitted(state, entry.event)) return false;
            feedback.waitAttempted = true;
            return true;
        });
        if (!reserved || !this.alive(entry)) { this.finish(entry); return; }
        // Never queue a reminder for later retry. Confirm the exact native turn
        // immediately before the SDK request; unknown or finished fails closed.
        const final = await this.activeJob(entry);
        if (final.state !== 'active' || !this.alive(entry)) { this.finish(entry); return; }
        const state = this.store.snapshot(), job = state.jobs[final.job.id];
        if (!job || job.state !== final.job.state || job.sessionId !== final.job.sessionId
            || job.turnId !== final.job.turnId || !this.permitted(state, entry.event)) {
            this.finish(entry); return;
        }
        const binding = job.bindingId === undefined ? undefined : state.bindings[job.bindingId];
        const defaults = job.replyDefaults ?? this.replyDefaults(state.policy, entry.event, binding);
        const mode = job.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode);
        if (mode === 'none' || mode === 'agent') { this.finish(entry); return; }
        let target;
        try { target = this.replyTarget(entry.event, mode); }
        catch { this.finish(entry); return; }
        if (!this.alive(entry)) return;
        let text;
        try {
            // A configured list takes precedence over the legacy single text.
            const choices = config.wait.texts ?? [config.wait.text];
            if (!Array.isArray(choices) || choices.length < 1 || choices.length > 50
                || !choices.every(validWaitText)) throw new Error('INVALID_FEEDBACK_CONFIG');
            const index = this.randomIndex(choices.length);
            if (!Number.isSafeInteger(index) || index < 0 || index >= choices.length)
                throw new Error('INVALID_FEEDBACK_CONFIG');
            text = choices[index];
        } catch {
            this.diagnostic('CHANNEL_FEEDBACK_CONFIG_INVALID');
            this.finish(entry);
            return;
        }
        if (!this.alive(entry)) return;
        try {
            const operation = this.access()?.feedbackWait?.(entry.event, target, text, entry.recordId);
            if (operation) void Promise.resolve(operation).catch(() => this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED'));
            else this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED');
        } catch { this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED'); }
        this.finish(entry);
    }
    dispose() {
        this.disposed = true;
        listeners.delete(this.observer);
        for (const entry of this.pending.values()) this.finish(entry);
    }
}
