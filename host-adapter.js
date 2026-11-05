import { promptText } from './core.js';

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
            const loaded = await Promise.all([...names].map(async world => {
                const book = await ctx.loadWorldInfo(world);
                if (!book || !book.entries) throw new Error('Worldbook unavailable');
                return Object.values(book.entries).map(e => ({ ...e, world }));
            }));
            return { books: [...names], entries: loaded.flat() };
        },
        render(e) {
            // A second macro evaluation can write variables or choose a different
            // random value. Never re-run a dynamic regex just to collect evidence.
            const scripts = regex.getRegexScripts({ allowedOnly: true });
            const dynamic = scripts.some(script => !script.disabled && script.promptOnly && script.placement?.includes(regex.regex_placement.WORLD_INFO) && (
                (Number(script.substituteRegex) !== 0 && script.findRegex?.includes('{{')) ||
                script.replaceString?.replace(/{{match}}/gi, '').includes('{{') ||
                script.trimStrings?.some(s => s.includes('{{'))
            ));
            if (dynamic || e.content?.includes('{{')) return '';
            const depth = e.position === wi.world_info_position.atDepth ? (e.depth ?? wi.DEFAULT_DEPTH) : null;
            return regex.getRegexedString(e.content, regex.regex_placement.WORLD_INFO, { depth, isMarkdown: false, isPrompt: true });
        },
        included(e, ctx) {
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
            const otherSources = [
                ...ctx.chat.map(m => m.mes ?? ''),
                ...Object.values(ctx.getCharacterCardFields?.() ?? {}).filter(v => typeof v === 'string'),
            ];
            return !otherSources.some(text => text.includes(needle));
        },
    };
}
