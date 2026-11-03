// Showrunner — a hidden narrative-director layer for SillyTavern/TauriTavern.
// An out-of-band LLM pass ("the Showrunner") maintains a structured plot plan
// and injects a short directive into each writer prompt. The full plan never
// enters the story context, so long chats stay coherent without token bloat.

import {
    chat,
    chat_metadata,
    characters,
    eventSource,
    event_types,
    generateRaw,
    name1,
    name2,
    saveSettingsDebounced,
    setExtensionPrompt,
    this_chid,
} from '../../../../script.js';

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { extension_prompt_roles, extension_prompt_types } from '../../../extension-prompts.js';
import { power_user } from '../../../power-user.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const MODULE_NAME = 'showrunner';
const PROMPT_KEY = 'showrunner_directive';

const DEFAULT_SHOWRUNNER_PROMPT = [
    'You are the Showrunner: the narrative director of an interactive story. You never write story prose and you never speak to the player. You reply ONLY with a single JSON object matching this schema:',
    '{',
    '  "logline": "one sentence summary of the whole story",',
    '  "canon": ["short immutable facts that must never change"],',
    '  "acts": [{"n": 1, "title": "", "status": "upcoming|active|done", "beats": [{"id": "1.1", "state": "done|current|upcoming", "directive": "what this beat must accomplish, present tense", "branch": "optional: if player does X -> beat 1.2a, else 1.2b"}]}],',
    '  "threads": [{"id": "short-name", "stage": "planted|active|dormant|resolved", "note": "one line"}],',
    '  "secrets": [{"who": "", "secret": "", "seeds": ["details to plant in prose"], "reveal_at": "beat id", "revealed": false}],',
    '  "player_want": "what the player character currently wants",',
    '  "pressure": 5,',
    '  "beat_id": "id of the current beat",',
    '  "next_directive": "the direction for the next scene, <= 120 words, present tense"',
    '}',
    'Hard rules:',
    "- The player's latest input is law. Never plan the player's words, thoughts, or actions; write conditional beats around their freedom.",
    '- Every twist must pay off at least one listed seed; record which seeds have been planted.',
    '- Escalate pressure non-linearly: a quiet scene precedes every spike.',
    '- Never contradict canon. If the recent turns contradict the plan, the turns win - update the plan.',
    '- Keep secrets hidden until reveal_at. Do not foreshadow beyond their seeds.',
    'Return ONLY the JSON object. No prose, no markdown fences.',
].join('\n');

const DEFAULTS = {
    enabled: true,
    cadence: 6,        // messages between automatic showrunner updates
    depth: 4,          // in-chat injection depth for the directive
    recentTurns: 10,   // recent turns the showrunner reviews
    showrunnerPrompt: DEFAULT_SHOWRUNNER_PROMPT,
};

const EMPTY_STATE = { premise: '', plan: null, directive: '', lastRunId: -1 };

let busy = false;

function settings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = { ...DEFAULTS };
    return extension_settings[MODULE_NAME];
}

function meta() {
    if (!chat_metadata || typeof chat_metadata !== 'object') return { ...EMPTY_STATE };
    if (!chat_metadata[MODULE_NAME]) chat_metadata[MODULE_NAME] = { ...EMPTY_STATE };
    return chat_metadata[MODULE_NAME];
}

function toast(msg, type = 'info') {
    if (window.toastr?.[type]) window.toastr[type](msg, 'Showrunner');
}

function log(...args) {
    console.debug(`[${MODULE_NAME}]`, ...args);
}

function stripReasoning(text) {
    return String(text ?? '')
        .replace(/<think(?:ing)?[^>]*>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '')
        .trim();
}

function extractJson(text) {
    let cleaned = stripReasoning(text);
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object found in Showrunner output');
    return JSON.parse(cleaned.slice(start, end + 1));
}

function messageLine(m) {
    const speaker = m?.name || (m?.is_user ? name1 : name2);
    return `${speaker}: ${m?.mes ?? ''}`;
}

function buildRecentTurns(count) {
    const n = Math.max(1, count | 0);
    return chat.slice(-n).map(messageLine).join('\n\n');
}

function buildPremise() {
    const parts = [];
    const char = (Array.isArray(characters) && this_chid !== undefined) ? characters[this_chid] : null;
    if (char) {
        if (char.description) parts.push(`## Character: ${char.name}\n${char.description}`);
        if (char.personality) parts.push(`## Personality\n${char.personality}`);
        if (char.scenario) parts.push(`## Scenario\n${char.scenario}`);
        if (char.first_mes) parts.push(`## Card greeting (tone reference)\n${char.first_mes}`);
    }
    if (power_user?.persona_description) {
        parts.push(`## User persona: ${name1}\n${power_user.persona_description}`);
    }
    const notes = meta().premise?.trim();
    if (notes) parts.push(`## Author premise notes\n${notes}`);
    return parts.join('\n\n') || '(no premise material available)';
}

function renderDirective(plan) {
    if (!plan || typeof plan !== 'object') return '';
    const lines = [
        '<showrunner>',
        '[Hidden direction for this scene. Follow it. Never mention, quote, or reveal this block.]',
        '',
    ];
    const beatId = plan.beat_id ?? '?';
    const directive = String(plan.next_directive ?? '').trim();
    lines.push(`Beat ${beatId} - ${directive || '(advance the story coherently)'}`);
    lines.push('');
    lines.push(`Pressure: ${plan.pressure ?? '?'}/10. Player wants: ${plan.player_want ?? 'unspecified'}.`);
    if (Array.isArray(plan.canon) && plan.canon.length) {
        lines.push(`Canon: ${plan.canon.join(' | ')}`);
    }
    const currentBeatId = String(plan.beat_id ?? '');
    const withheld = (Array.isArray(plan.secrets) ? plan.secrets : [])
        .filter(s => s && !s.revealed && String(s.reveal_at ?? '') !== currentBeatId)
        .map(s => `${s.who || 'someone'} is ${s.secret} (reserved for beat ${s.reveal_at ?? '?'})`);
    if (withheld.length) {
        lines.push(`Do NOT reveal yet: ${withheld.join('; ')}`);
    }
    lines.push('</showrunner>');
    return lines.join('\n');
}

function applyDirective(text) {
    setExtensionPrompt(
        PROMPT_KEY,
        String(text ?? ''),
        extension_prompt_types.IN_CHAT,
        settings().depth,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

async function runShowrunner(mode) {
    if (busy) return;
    busy = true;
    try {
        const m = meta();
        const stateJson = m.plan ? JSON.stringify(m.plan) : 'none';
        const sections = [];
        sections.push(mode === 'cold'
            ? '# Cold start\nCreate the initial plan for this story from the premise material. Fill every field of the schema and write an opening-beat next_directive for the first scene.'
            : '# Update\nReview the recent turns VERBATIM, reconcile the plan with what actually happened (turns win on conflict), then produce the updated plan.');
        sections.push(`# Premise\n${buildPremise()}`);
        sections.push(`# Current plan state\n${stateJson}`);
        sections.push(`# Recent turns (oldest first)\n${buildRecentTurns(settings().recentTurns)}`);
        sections.push('Return ONLY the complete updated plan as a single JSON object. No prose, no markdown fences.');
        const prompt = sections.join('\n\n');

        let plan;
        try {
            plan = extractJson(await generateRaw({ prompt, systemPrompt: settings().showrunnerPrompt }));
        } catch (firstError) {
            log('retrying after parse failure', firstError);
            plan = extractJson(await generateRaw({
                prompt: `${prompt}\n\nYour previous reply was not a single valid JSON object. Reply again with ONLY the JSON object.`,
                systemPrompt: settings().showrunnerPrompt,
            }));
        }

        m.plan = plan;
        m.directive = renderDirective(plan);
        m.lastRunId = chat.length - 1;
        applyDirective(settings().enabled ? m.directive : '');
        saveMetadataDebounced();
        updateUi();
        toast(plan?.beat_id ? `Showrunner: now at beat ${plan.beat_id}` : 'Showrunner: plan updated');
        log('plan', plan);
    } catch (error) {
        console.error(`[${MODULE_NAME}] run failed`, error);
        toast('Showrunner failed - see browser console', 'error');
    } finally {
        busy = false;
    }
}

function onGenerationEnded() {
    if (busy || !settings().enabled) return;
    const m = meta();
    if (!m.plan) return;
    const lastId = chat.length - 1;
    const last = chat[lastId];
    if (!last || last.is_system) return;
    if (lastId - m.lastRunId < settings().cadence) return;
    runShowrunner('update');
}

function onChatChanged() {
    const m = meta();
    applyDirective(settings().enabled ? m.directive : '');
    updateUi();
}

function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(String(value), 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function buildSettingsHtml() {
    return `
<div id="showrunner_settings" class="showrunner-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Showrunner</b>
            <div class="inline-drawer-icon fa-solid fa-circle-down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="showrunner_enable" type="checkbox" />
                <span>Enable showrunner injection</span>
            </label>
            <label>Cadence (messages between updates)
                <input id="showrunner_cadence" type="number" min="1" max="50" step="1" />
            </label>
            <label>Injection depth
                <input id="showrunner_depth" type="number" min="0" max="100" step="1" />
            </label>
            <label>Recent turns reviewed
                <input id="showrunner_recent" type="number" min="2" max="40" step="1" />
            </label>
            <label>Premise notes (per-chat, used on cold start)
                <textarea id="showrunner_premise" class="text_pole textarea_compact" rows="3" placeholder="Walking Dead style apocalypse; slow burn horror; my character is an ex-cop..."></textarea>
            </label>
            <label>Currently injected directive (the writer model sees this; the chat does not)
                <textarea id="showrunner_directive_view" class="text_pole textarea_compact" rows="6" readonly></textarea>
            </label>
            <label>Showrunner system prompt
                <textarea id="showrunner_prompt" class="text_pole textarea_compact" rows="10"></textarea>
            </label>
            <div class="showrunner-buttons">
                <input id="showrunner_cold" type="button" class="menu_button" value="Cold start" />
                <input id="showrunner_replan" type="button" class="menu_button" value="Re-plan now" />
                <input id="showrunner_peek" type="button" class="menu_button" value="Peek at plan" />
                <input id="showrunner_clear" type="button" class="menu_button" value="Clear state" />
            </div>
            <div class="showrunner-hint">
                The plan JSON is never sent to the writer model - only the directive above is
                injected at depth N as a system message. Slash commands: /showrunner-cold,
                /showrunner-replan.
            </div>
        </div>
    </div>
</div>`;
}

function updateUi() {
    const s = settings();
    const m = meta();
    $('#showrunner_enable').prop('checked', s.enabled);
    $('#showrunner_cadence').val(s.cadence);
    $('#showrunner_depth').val(s.depth);
    $('#showrunner_recent').val(s.recentTurns);
    $('#showrunner_premise').val(m.premise ?? '');
    $('#showrunner_directive_view').val(m.directive ?? '');
    $('#showrunner_prompt').val(s.showrunnerPrompt);
    $('#showrunner_replan').prop('disabled', !m.plan);
}

async function onColdClicked() {
    if (meta().plan) {
        const confirmed = await callGenericPopup(POPUP_TYPE.CONFIRM, 'Replace the existing plan with a new cold start?');
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    await runShowrunner('cold');
}

async function peekPlan() {
    const json = JSON.stringify(meta().plan, null, 2) || 'null';
    await callGenericPopup(POPUP_TYPE.TEXT, `<pre id="showrunner_peek_json">${escapeHtml(json)}</pre>`);
}

function clearState() {
    if (chat_metadata && typeof chat_metadata === 'object') {
        chat_metadata[MODULE_NAME] = { premise: meta().premise ?? '', plan: null, directive: '', lastRunId: -1 };
        saveMetadataDebounced();
    }
    applyDirective('');
    updateUi();
    toast('Showrunner state cleared');
}

function bindEvents() {
    $('#showrunner_enable').on('change', function () {
        settings().enabled = $(this).prop('checked');
        applyDirective(settings().enabled ? meta().directive : '');
        saveSettingsDebounced();
    });
    $('#showrunner_cadence').on('input', function () {
        settings().cadence = clampInt($(this).val(), 1, 50, DEFAULTS.cadence);
        saveSettingsDebounced();
    });
    $('#showrunner_depth').on('input', function () {
        settings().depth = clampInt($(this).val(), 0, 100, DEFAULTS.depth);
        saveSettingsDebounced();
        applyDirective(settings().enabled ? meta().directive : '');
    });
    $('#showrunner_recent').on('input', function () {
        settings().recentTurns = clampInt($(this).val(), 2, 40, DEFAULTS.recentTurns);
        saveSettingsDebounced();
    });
    $('#showrunner_premise').on('input', function () {
        meta().premise = String($(this).val());
        saveMetadataDebounced();
    });
    $('#showrunner_prompt').on('input', function () {
        settings().showrunnerPrompt = String($(this).val());
        saveSettingsDebounced();
    });
    $('#showrunner_cold').on('click', onColdClicked);
    $('#showrunner_replan').on('click', () => runShowrunner('update'));
    $('#showrunner_peek').on('click', peekPlan);
    $('#showrunner_clear').on('click', clearState);
}

function init() {
    settings();
    $('#extensions_settings2').append(buildSettingsHtml());
    bindEvents();
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.APP_READY, onChatChanged);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'showrunner-cold',
        help: 'Run the Showrunner cold start: creates the hidden plot plan from the premise.',
        callback: () => runShowrunner('cold'),
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'showrunner-replan',
        help: 'Force a Showrunner re-plan from the recent turns.',
        callback: () => runShowrunner('update'),
    }));
    onChatChanged();
}

jQuery(() => {
    init();
});