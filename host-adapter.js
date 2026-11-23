import { promptText } from './core.js';

const CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];

/** Version-bound native modules, all read-only. See docs/API-SOURCES.md. */
export function createAdapter(wi, regex, openai) {
    function booksForCharacter(c, character) {
        if (!character) return [];
        const filename = character.avatar?.replace(/\.[^/.]+$/, '');
        return [character.data?.extensions?.world, ...(wi.world_info.charLore?.find(x => x.name === filename)?.extraBooks ?? [])].filter(Boolean);
    }
    return {
        async list(ctx) {
            const names = new Set([
                ...wi.selected_world_info,
                ctx.chatMetadata.world_info,
                ctx.powerUserSettings?.persona_description_lorebook,
            ].filter(Boolean));
            if (ctx.groupId) {
                const group = ctx.groups.find(x => String(x.id) === String(ctx.groupId));
                for (const avatar of group?.members ?? []) {
                    if (group.disabled_members?.includes(avatar)) continue;
                    for (const name of booksForCharacter(ctx, ctx.characters.find(x => x.avatar === avatar))) names.add(name);
                }
            } else {
                for (const name of booksForCharacter(ctx, ctx.characters[ctx.characterId])) names.add(name);
            }
            // Read only books participating in this chat. Empty books remain visible.
            const nameList = [...names];
            const results = await Promise.allSettled(nameList.map(async world => {
                const book = await ctx.loadWorldInfo(world);
                if (!book || !book.entries) throw new Error('Worldbook unavailable');
                return { world, entries: Object.values(book.entries).map(e => ({ ...e, world })) };
            }));
            const loadedBooks = [];
            const loadedEntries = [];
            let hadFailures = false;
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === 'fulfilled') {
                    loadedBooks.push(r.value.world);
                    loadedEntries.push(...r.value.entries);
                } else {
                    hadFailures = true;
                    console.warn(`世界书自动开关管理器：加载世界书 "${nameList[i]}" 失败已跳过：`, r.reason);
                }
            }
            if (hadFailures && !loadedBooks.length && nameList.length) {
                throw new Error('所有世界书均不可用');
            }
            return { books: loadedBooks, entries: loadedEntries };
        },
        /** Read the current chat back from the server (used to confirm a save). */
        async readSavedChat(ctx) {
            const id = ctx.getCurrentChatId();
            const headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
            let response;
            if (ctx.groupId) {
                response = await fetch('/api/chats/group/get', { method: 'POST', headers, cache: 'no-cache', body: JSON.stringify({ id }) });
            } else {
                const c = ctx.characters?.[ctx.characterId];
                if (!c) throw new Error('No character');
                response = await fetch('/api/chats/get', { method: 'POST', headers, cache: 'no-cache', body: JSON.stringify({ ch_name: c.name, file_name: id, avatar_url: c.avatar }) });
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const rows = await response.json();
            // Group chat files are returned without the header line.
            return ctx.groupId && Array.isArray(rows) && rows[0] && !('chat_metadata' in rows[0]) ? [{ chat_metadata: {} }, ...rows] : rows;
        },
        /** Names of every worldbook that exists on the server (for stale-selection display). */
        allBooks() { return Array.isArray(wi.world_names) ? [...wi.world_names] : null; },
        /**
         * Per-generation cache. Regex scripts and the comparison sources are read once
         * per request instead of once per entry; character fields are read raw so no
         * card macro is evaluated (macros may write variables or roll random values).
         */
        prepare(ctx) {
            const scripts = regex.getRegexScripts({ allowedOnly: true });
            const dynamic = scripts.some(script => !script.disabled && script.promptOnly && script.placement?.includes(regex.regex_placement.WORLD_INFO) && (
                (Number(script.substituteRegex) !== 0 && script.findRegex?.includes('{{')) ||
                script.replaceString?.replace(/{{match}}/gi, '').includes('{{') ||
                script.trimStrings?.some(s => s.includes('{{'))
            ));
            let sources = null;
            return {
                dynamic,
                charName: ctx?.characters?.[ctx?.characterId]?.name ?? ctx?.name2 ?? '',
                userName: ctx?.name1 ?? ctx?.user?.name ?? '',
                get sources() {
                    if (sources) return sources;
                    const chars = ctx?.groupId
                        ? (ctx.groups?.find(g => String(g.id) === String(ctx.groupId))?.members ?? []).map(a => ctx.characters?.find(c => c.avatar === a))
                        : [ctx?.characters?.[ctx?.characterId]];
                    const fields = [];
                    for (const c of chars.filter(Boolean)) {
                        for (const f of CARD_FIELDS) {
                            const v = c.data?.[f] ?? c[f];
                            if (typeof v === 'string' && v) fields.push(v);
                        }
                    }
                    const persona = ctx?.powerUserSettings?.persona_description;
                    sources = [...(ctx?.chat ?? []).map(m => m?.mes ?? ''), ...fields, ...(typeof persona === 'string' ? [persona] : [])];
                    return sources;
                },
            };
        },
        render(e, ctx, cache = this.prepare(ctx)) {
            // A second macro evaluation can write variables or choose a different
            // random value. Never re-run a dynamic regex just to collect evidence.
            if (cache.dynamic || !e.content) return '';
            let content = e.content;
            if (content.includes('{{')) {
                content = content
                    .replace(/{{\s*char\s*}}/gi, cache.charName)
                    .replace(/{{\s*user\s*}}/gi, cache.userName);
            }
            if (content.includes('{{')) {
                const chunks = content.split(/{{[^}]+}}/).map(s => s.trim()).filter(s => s.length >= 6);
                if (!chunks.length) return '';
                chunks.sort((a, b) => b.length - a.length);
                content = chunks[0];
            }
            const depth = e.position === wi.world_info_position.atDepth ? (e.depth ?? wi.DEFAULT_DEPTH) : null;
            return regex.getRegexedString(content, regex.regex_placement.WORLD_INFO, { depth, isMarkdown: false, isPrompt: true });
        },
        included(e, ctx, cache) {
            const needle = e.rendered.trim();
            if (ctx.mainApi === 'openai' && [0, 1].includes(e.position)) {
                // The prompt manager keeps source identifiers even when an identical
                // passage is present in chat history. Disabled WI slots cannot count.
                const identifier = e.position === 0 ? 'worldInfoBefore' : 'worldInfoAfter';
                const collection = openai.promptManager?.messages?.collection ?? [];
                const slot = collection.find(m => m.identifier === identifier);
                if (!slot) return false;
                const messages = slot.collection ?? [slot];
                return messages.some(m => promptText(m).includes(needle));
            }
            // Other positions can be mixed into examples, author notes or depth
            // injections. Refuse ambiguous content already present in other sources.
            const sources = (cache ?? this.prepare(ctx)).sources;
            return !sources.some(text => text.includes(needle));
        },
        scanOptions() {
            return {
                scanDepth: Number(wi?.world_info_depth) || 2,
                maxRecursionSteps: Number(wi?.world_info_max_recursion_steps) || 0,
                caseSensitive: Boolean(wi?.world_info_case_sensitive),
                matchWholeWords: Boolean(wi?.world_info_match_whole_words),
            };
        },
    };
}
