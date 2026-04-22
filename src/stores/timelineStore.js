import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { executeFetch } from '@/api/fetchStrategy.js'
import { CORE_STATS, createDefaultStats } from '@/utils/coreStats.js'
import { i18n } from '@/i18n'
import { snapMs } from '@/utils/precision.js'

const tr = (key, params) => i18n.global.t(key, params)

// 修改技能类型翻译映射
const getI18nSkillType = (type) => {
    const keys = {
        'basic_attack': '普通攻击',
        'dodge': '闪避',
        'special_attack': '特殊技',
        'link': '连携技',
        'ultimate': '终结技'
    }
    return keys[type] || tr(`skillType.${type}`)
}

const uid = () => Math.random().toString(36).substring(2, 9)
const ATTACK_SEGMENT_COUNT = 5
const COLLAPSED_PREP_PX = 18
const MIN_PREP_DURATION = 0.5

const createOwnSkillLinkEnhancer = ({ linkSubtract = 0.0 } = {}) => {
    return ({ track, enhStart, baseDuration, ultimateAction, getShiftedEndTime }) => {
        const epsilon = 0.0001
        const processed = new Set()
        let extraDuration = 0

        let guard = 0
        while (guard++ < 200) {
            const currentEnd = getShiftedEndTime(enhStart, baseDuration + extraDuration, ultimateAction.instanceId)

            let foundAny = false
            for (const a of (track?.actions || [])) {
                if (!a || a.isDisabled || (a.triggerWindow || 0) < 0) continue
                if (a.type !== 'skill' && a.type !== 'link') continue
                if (processed.has(a.instanceId)) continue

                const t = Number(a.startTime) || 0
                if (t + epsilon < enhStart) continue
                if (t >= currentEnd - epsilon) continue

                let delta = Number(a.duration) || 0
                if (a.type === 'link') {
                    delta = Math.max(0, delta - linkSubtract)
                }
                processed.add(a.instanceId)

                if (delta <= 0) continue
                extraDuration += delta
                foundAny = true
            }

            if (!foundAny) break
        }

        return extraDuration
    }
}

const ULTIMATE_ENHANCEMENT_EXTENDERS = {
    ['LAEVATAIN']: createOwnSkillLinkEnhancer({ linkSubtract: 0.5 }),
}

function shiftSnapshotTimes(snapshot, delta) {
    const d = Number(delta) || 0
    if (!snapshot || !Number.isFinite(d) || d === 0) return snapshot

    const shiftVal = (v) => {
        const n = Number(v) || 0
        const out = n + d
        return out < 0 ? 0 : out
    }

    const shiftStartLike = (obj) => {
        if (!obj || typeof obj !== 'object') return
        if (obj.startTime !== undefined) obj.startTime = shiftVal(obj.startTime)
        if (obj.logicalStartTime !== undefined) obj.logicalStartTime = shiftVal(obj.logicalStartTime)
        if (obj.time !== undefined) obj.time = shiftVal(obj.time)
    }

    if (Array.isArray(snapshot.tracks)) {
        snapshot.tracks.forEach((track) => {
            if (!track || !Array.isArray(track.actions)) return
            track.actions.forEach(shiftStartLike)
        })
    }

    if (Array.isArray(snapshot.cycleBoundaries)) {
        snapshot.cycleBoundaries.forEach(shiftStartLike)
    }

    if (Array.isArray(snapshot.switchEvents)) {
        snapshot.switchEvents.forEach(shiftStartLike)
    }

    return snapshot
}

function normalizePrepConfig(snapshot) {
    const hasPrep = snapshot && (snapshot.prepDuration !== undefined || snapshot.prepExpanded !== undefined)
    if (hasPrep) {
        const dur = Number(snapshot.prepDuration)
        if (Number.isFinite(dur)) {
            const clamped = Math.max(MIN_PREP_DURATION, dur)
            if (Math.abs(clamped - dur) > 0.0001) {
                shiftSnapshotTimes(snapshot, clamped - dur)
            }
            snapshot.prepDuration = clamped
        } else {
            snapshot.prepDuration = 5
        }
        snapshot.prepExpanded = snapshot.prepExpanded !== false
        return { snapshot, migrated: false }
    }

    const migratedSnapshot = snapshot || {}
    migratedSnapshot.prepDuration = 5
    migratedSnapshot.prepExpanded = true
    shiftSnapshotTimes(migratedSnapshot, 5)
    return { snapshot: migratedSnapshot, migrated: true }
}

function normalizeAttackSegmentsForCharacter(char) {
    if (!char) return
    if (!Array.isArray(char.basic_attack_segments)) char.basic_attack_segments = []
    if (!Array.isArray(char.special_attack_segments)) char.special_attack_segments = []
}

export const useTimelineStore = defineStore('timeline', () => {

    const DEFAULT_SYSTEM_CONSTANTS = {
        maxSp: 300,
        initialSp: 200,
        spRegenRate: 8,
        skillSpCostDefault: 100,
        linkCdReduction: 0,
        maxStagger: 100,
        staggerNodeCount: 0,
        staggerNodeDuration: 2,
        staggerBreakDuration: 10,
        executionRecovery: 25
    }

    const systemConstants = ref({ ...DEFAULT_SYSTEM_CONSTANTS })

    const BASE_BLOCK_WIDTH = ref(50)
    const ZOOM_LIMITS = {
        MIN: 15,
        MAX: 1200
    }
    const TOTAL_DURATION = 120
    const MAX_SCENARIOS = 14

    const prepDuration = ref(5)
    const prepExpanded = ref(true)

    const isLoading = ref(true)
    const characterRoster = ref([])
    const iconDatabase = ref({})
    const cycleBoundaries = ref([])

    const activeScenarioId = ref('default_sc')

    const viewDuration = computed(() => (Number(prepDuration.value) || 0) + TOTAL_DURATION)
    const prepZoneWidthPx = computed(() => {
        const dur = Number(prepDuration.value) || 0
        if (dur <= 0) return 0
        if (prepExpanded.value) return dur * timeBlockWidth.value
        return COLLAPSED_PREP_PX
    })

    function timeToPx(time) {
        const t = Number(time) || 0
        const dur = Number(prepDuration.value) || 0
        const width = timeBlockWidth.value
        if (dur <= 0 || prepExpanded.value) return t * width
        if (t <= dur) return (t / dur) * COLLAPSED_PREP_PX
        return COLLAPSED_PREP_PX + (t - dur) * width
    }

    function pxToTime(px) {
        const x = Number(px) || 0
        const dur = Number(prepDuration.value) || 0
        const width = timeBlockWidth.value
        if (dur <= 0 || prepExpanded.value) return x / width
        if (x <= COLLAPSED_PREP_PX) return (x / COLLAPSED_PREP_PX) * dur
        return dur + (x - COLLAPSED_PREP_PX) / width
    }

    const totalTimelineWidthPx = computed(() => timeToPx(viewDuration.value))

    function toBattleTime(viewTime) {
        return (Number(viewTime) || 0) - (Number(prepDuration.value) || 0)
    }

    function formatAxisTimeLabel(viewTime) {
        const bt = toBattleTime(viewTime)
        if (!Number.isFinite(bt)) return ''
        const sign = bt < 0 ? '-' : ''
        const abs = Math.abs(bt)
        const totalFrames = Math.round(abs * 60)
        const s = Math.floor(totalFrames / 60)
        const f = totalFrames % 60
        if (f === 0) return `${sign}${s}s`
        return `${sign}${s}s ${f.toString().padStart(2, '0')}t`
    }

    const ELEMENT_COLORS = {
        "blaze": "#ff4d4f", "cold": "#00e5ff", "emag": "#ffbf00", "nature": "#52c41a", "physical": "#e0e0e0",
        "link": "#fdd900", "execution": "#a61d24", "dodge": "#69c0ff", "skill": "#ffffff", "ultimate": "#00e5ff", "attack": "#aaaaaa", "default": "#8c8c8c",
        'blaze_attach': '#ff4d4f', 'blaze_burst': '#ff7875', 'burning': '#f5222d',
        'cold_attach': '#00e5ff', 'cold_burst': '#40a9ff', 'frozen': '#1890ff', 'ice_shatter': '#bae7ff',
        'emag_attach': '#ffd700', 'emag_burst': '#fff566', 'conductive': '#ffec3d',
        'nature_attach': '#95de64', 'nature_burst': '#73d13d', 'corrosion': '#52c41a',
        'break': '#d9d9d9', 'armor_break': '#d9d9d9', 'stagger': '#d9d9d9',
        'knockdown': '#d9d9d9', 'knockup': '#d9d9d9',
    }

    const getColor = (key) => ELEMENT_COLORS[key] || ELEMENT_COLORS.default

    const ENEMY_TIERS = [
        { labelKey: 'enemyTier.normal', label: '普通', value: 'normal', color: '#a0a0a0' },
        { labelKey: 'enemyTier.elite', label: '进阶', value: 'elite', color: '#52c41a' },
        { labelKey: 'enemyTier.champion', label: '精英', value: 'champion', color: '#d8b4fe' },
        { labelKey: 'enemyTier.head', label: '头目', value: 'head', color: '#ffd700' },
        { labelKey: 'enemyTier.boss', label: '领袖', value: 'boss', color: '#ff4d4f' }
    ]

    const scenarioList = ref([
        { id: 'default_sc', name: tr('timeline.scenario.defaultName', { index: 1 }), data: null }
    ])

    const createEmptyTrack = () => ({
        id: null,
        actions: [],
        initialGauge: 0,
        maxGaugeOverride: null,
        gaugeEfficiency: 100,
        originiumArtsPower: 0,
        stats: createDefaultStats(),
        linkCdReduction: 0,
    })

    const createDefaultTracks = () => [
        createEmptyTrack(),
        createEmptyTrack(),
        createEmptyTrack(),
        createEmptyTrack()
    ]


    const tracks = ref(createDefaultTracks())
    const characterOverrides = ref({})

    const actionMap = computed(() => {
        const map = new Map()
        for (let i = 0; i < tracks.value.length; i++) {
            const track = tracks.value[i]
            for (const action of track.actions) {
                map.set(action.instanceId, {
                    trackId: track.id,
                    trackIndex: i,
                    node: action,
                    type: 'action',
                    id: action.instanceId,
                })
            }
        }
        return map
    })

    const effectsMap = computed(() => {
        const map = new Map()
        for (const track of tracks.value) {
            for (const action of track.actions) {
                if (!action.physicalAnomaly || !action.physicalAnomaly.length) {
                    continue
                }
                let currentFlatIndex = 0
                for (let i = 0; i < action.physicalAnomaly.length; i++) {
                    const row = action.physicalAnomaly[i]
                    for (let j = 0; j < row.length; j++) {
                        const effect = row[j]
                        map.set(effect._id, {
                            id: effect._id,
                            node: effect,
                            actionId: action.instanceId,
                            rowIndex: i,
                            colIndex: j,
                            flatIndex: currentFlatIndex++,
                            type: 'effect'
                        })
                    }
                }
            }
        }
        return map
    })

    function setBaseBlockWidth(val) {
        const sanitizedVal = Math.min(ZOOM_LIMITS.MAX, Math.max(ZOOM_LIMITS.MIN, val))
        BASE_BLOCK_WIDTH.value = sanitizedVal
    }

    function getActionById(actionId) {
        return actionMap.value.get(actionId)
    }

    function getEffectById(effectId) {
        return effectsMap.value.get(effectId)
    }

    function resolveNode(nodeId) {
        return getActionById(nodeId) || getEffectById(nodeId)
    }

    const isCharacterInTeam = (charId) => {
        return tracks.value.some(track => track.id === charId)
    }

    function changeTrackOperator(trackIndex, charId) {
        tracks.value.forEach((t, idx) => {
            if (t.id === charId && idx !== trackIndex) {
                t.id = null
                t.actions = []
            }
        })

        const track = tracks.value[trackIndex]
        if (track && track.id !== charId) {
            track.id = charId
            track.actions = [] 
        }
        
        commitState()
    }

    function clearTrackOperator(trackIndex) {
        const track = tracks.value[trackIndex]
        if (track) {
            track.id = null
            track.actions = []
            commitState()
        }
    }

    function updateTrackGaugeEfficiency(trackId, value) {
        const track = tracks.value.find(t => t.id === trackId);
        if (track) {
            const cleanValue = snapMs(Number(value));
            track.gaugeEfficiency = cleanValue;
            if (!track.stats) track.stats = createDefaultStats();
            track.stats.ult_charge_eff = cleanValue;
            commitState();
        }
    }

    function updateTrackOriginiumArtsPower(trackId, value) {
        const track = tracks.value.find(t => t.id === trackId);
        if (track) {
            track.originiumArtsPower = value;
            if (!track.stats) track.stats = createDefaultStats()
            track.stats.originium_arts_power = Number(value) || 0
            commitState();
        }
    }

    function updateTrackLinkCdReduction(trackId, value) {
        const track = tracks.value.find(t => t.id === trackId);
        if (track) {
            track.linkCdReduction = clampPercent(value);
            if (!track.stats) track.stats = createDefaultStats()
            track.stats.link_cd_reduction = Number(track.linkCdReduction) || 0
            commitState();
        }
    }

    const activeTrackId = ref(null)
    const timelineScrollTop = ref(0)
    const timelineShift = ref(0)
    const timelineRect = ref({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
    const trackLaneRects = ref({})
    const showCursorGuide = ref(false)
    const cursorPosition = ref({ x: 0, y: 0 })
    const snapStep = ref(0.1)
    const draggingSkillData = ref(null)
    const selectedActionId = ref(null)
    const selectedLibrarySkillId = ref(null)
    const selectedLibrarySource = ref('character')
    const selectedAnomalyId = ref(null)
    const selectedCycleBoundaryId = ref(null)
    const switchEvents = ref([])
    const selectedSwitchEventId = ref(null)
    const multiSelectedIds = ref(new Set())
    const isBoxSelectMode = ref(false)
    const clipboard = ref(null)
    const isCapturing = ref(false)
    const hoveredActionId = ref(null)

    const cursorPosTimeline = computed(() => toTimelineSpace(cursorPosition.value.x, cursorPosition.value.y))
    const cursorCurrentTime = computed(() => {
        const exactTime = pxToTime(cursorPosTimeline.value.x)
        const clamped = Math.min(Math.max(0, exactTime), viewDuration.value)
        return snapMs(clamped)
    })

    function setIsCapturing(val) { isCapturing.value = val }
    const isActionSelected = (id) => selectedActionId.value === id || multiSelectedIds.value.has(id)

    const historyStack = ref([])
    const historyIndex = ref(-1)
    const MAX_HISTORY = 50

    function commitState() {
        if (historyIndex.value < historyStack.value.length - 1) {
            historyStack.value = historyStack.value.slice(0, historyIndex.value + 1)
        }
        const snapshot = JSON.stringify({
            tracks: tracks.value,
            prepDuration: prepDuration.value,
            prepExpanded: prepExpanded.value,
            cycleBoundaries: cycleBoundaries.value,
            switchEvents: switchEvents.value
        })
        historyStack.value.push(snapshot)
        if (historyStack.value.length > MAX_HISTORY) {
            historyStack.value.shift()
        } else {
            historyIndex.value++
        }
    }

    function undo() {
        if (historyIndex.value <= 0) return
        historyIndex.value--
        restoreState(JSON.parse(historyStack.value[historyIndex.value]))
    }

    function redo() {
        if (historyIndex.value >= historyStack.value.length - 1) return
        historyIndex.value++
        restoreState(JSON.parse(historyStack.value[historyIndex.value]))
    }

    function restoreState(snapshot) {
        const rawPrep = Number(snapshot?.prepDuration)
        if (snapshot?.prepDuration !== undefined && Number.isFinite(rawPrep) && rawPrep < MIN_PREP_DURATION) {
            shiftSnapshotTimes(snapshot, MIN_PREP_DURATION - rawPrep)
        }
        tracks.value = normalizeTracks(snapshot.tracks)
        if (snapshot.prepDuration !== undefined) prepDuration.value = Math.max(MIN_PREP_DURATION, Number(snapshot.prepDuration) || 0)
        if (snapshot.prepExpanded !== undefined) prepExpanded.value = snapshot.prepExpanded !== false
        cycleBoundaries.value = snapshot.cycleBoundaries || []
        switchEvents.value = snapshot.switchEvents || []
        clearSelection()
    }

    function _createSnapshot() {
        return JSON.parse(JSON.stringify({
            tracks: tracks.value,
            prepDuration: prepDuration.value,
            prepExpanded: prepExpanded.value,
            systemConstants: systemConstants.value,
            cycleBoundaries: cycleBoundaries.value,
            switchEvents: switchEvents.value
        }))
    }

    function setDraggingSkill(skill) { draggingSkillData.value = skill }

    function _loadSnapshot(data) {
        if (!data) return
        const normalized = normalizePrepConfig(JSON.parse(JSON.stringify(data)))
        const incoming = normalized.snapshot
        tracks.value = normalizeTracks(incoming.tracks || createDefaultTracks())
        normalizeComboLinksInTracks()
        prepDuration.value = Math.max(MIN_PREP_DURATION, Number(incoming.prepDuration) || 0)
        prepExpanded.value = incoming.prepExpanded !== false
        if (incoming.systemConstants) systemConstants.value = { ...systemConstants.value, ...incoming.systemConstants }
        cycleBoundaries.value = incoming.cycleBoundaries ? JSON.parse(JSON.stringify(incoming.cycleBoundaries)) : []
        switchEvents.value = incoming.switchEvents ? JSON.parse(JSON.stringify(incoming.switchEvents)) : []
        clearSelection()
    }

    function switchScenario(targetId) {
        if (targetId === activeScenarioId.value) return
        const currentScenario = scenarioList.value.find(s => s.id === activeScenarioId.value)
        if (currentScenario) currentScenario.data = _createSnapshot()
        const targetScenario = scenarioList.value.find(s => s.id === targetId)
        if (!targetScenario) return
        if (targetScenario.data) _loadSnapshot(targetScenario.data)
        else targetScenario.data = _createSnapshot()
        activeScenarioId.value = targetId
        historyStack.value = []; historyIndex.value = -1; commitState()
    }

    function addScenario() {
        if (scenarioList.value.length >= MAX_SCENARIOS) return
        const currentScenario = scenarioList.value.find(s => s.id === activeScenarioId.value)
        if (currentScenario) currentScenario.data = _createSnapshot()
        const newId = `sc_${uid()}`
        const emptySnapshot = {
            tracks: createDefaultTracks(),
            prepDuration: 5,
            prepExpanded: true,
            systemConstants: { ...DEFAULT_SYSTEM_CONSTANTS }
        }
        scenarioList.value.push({ id: newId, name: tr('timeline.scenario.defaultName', { index: scenarioList.value.length + 1 }), data: emptySnapshot })
        activeScenarioId.value = newId
        _loadSnapshot(emptySnapshot)
        historyStack.value = []; historyIndex.value = -1; commitState()
    }

    function duplicateScenario(sourceId) {
        if (scenarioList.value.length >= MAX_SCENARIOS) return
        const currentActive = scenarioList.value.find(s => s.id === activeScenarioId.value)
        if (currentActive) currentActive.data = _createSnapshot()
        const source = scenarioList.value.find(s => s.id === sourceId)
        if (!source) return
        const newId = `sc_${uid()}`
        const newData = JSON.parse(JSON.stringify(source.data || _createSnapshot()))
        scenarioList.value.push({ id: newId, name: `${source.name} (${tr('timeline.scenario.copySuffix')})`, data: newData })
        activeScenarioId.value = newId
        _loadSnapshot(newData)
        historyStack.value = []; historyIndex.value = -1; commitState()
    }

    function deleteScenario(targetId) {
        if (scenarioList.value.length <= 1) return
        const idx = scenarioList.value.findIndex(s => s.id === targetId)
        if (idx === -1) return
        if (targetId === activeScenarioId.value) {
            const nextSc = scenarioList.value[idx - 1] || scenarioList.value[idx + 1]
            switchScenario(nextSc.id)
        }
        scenarioList.value.splice(idx, 1)
    }

    const timeBlockWidth = computed(() => BASE_BLOCK_WIDTH.value)
    const ensureEffectId = (effect) => {
        if (!effect._id) effect._id = uid()
        return effect._id
    }
    const clampPercent = (val) => Math.min(100, Math.max(0, Number(val) || 0))

    const normalizeTrack = (track) => {
        if (!track) return createEmptyTrack()
        const merged = { ...createEmptyTrack(), ...track, actions: track.actions || [] }
        const hasIncomingStats = track.stats && typeof track.stats === 'object'
        merged.stats = { ...createDefaultStats(), ...(hasIncomingStats ? track.stats : {}) }
        if (!hasIncomingStats) {
            merged.stats.ult_charge_eff = Number(track.gaugeEfficiency) || 0
            merged.stats.link_cd_reduction = Number(track.linkCdReduction) || 0
            merged.stats.originium_arts_power = Number(track.originiumArtsPower) || 0
        }
        merged.gaugeEfficiency = Number(merged.stats.ult_charge_eff) || 0
        merged.linkCdReduction = clampPercent(merged.stats.link_cd_reduction)
        merged.originiumArtsPower = Number(merged.stats.originium_arts_power) || 0
        return merged
    }
    const normalizeTracks = (list = []) => list.map(t => normalizeTrack(t))

    const getCharacterElementColor = (characterId) => {
        const charInfo = characterRoster.value.find(c => c.id === characterId)
        return charInfo?.element ? (ELEMENT_COLORS[charInfo.element] || ELEMENT_COLORS.default) : ELEMENT_COLORS.default
    }
    const getModifierLabel = (modifierId) => {
        const found = (misc.value?.modifierDefs || []).find(d => d.id === modifierId)
        if (found?.label) return found.label
        const core = CORE_STATS.find(s => s.id === modifierId)
        return (core?.labelKey && tr(core.labelKey) !== core.labelKey) ? tr(core.labelKey) : (core?.label || modifierId || '')
    }

    const teamTracksInfo = computed(() => tracks.value.map(t => ({ ...t, ...(characterRoster.value.find(c => c.id === t.id) || { name: tr('timelineGrid.track.selectOperator'), avatar: '', rarity: 0 }) })))
    const formatTimeLabel = (t) => {
        if (t == null) return ''; const f = Math.round(t * 60); const s = Math.floor(f / 60); return f % 60 === 0 ? `${s}s` : `${s}s ${(f % 60).toString().padStart(2, '0')}f`
    }

    // 更新技能库计算逻辑
    const activeSkillLibrary = computed(() => {
        const char = characterRoster.value.find(c => c.id === activeTrackId.value); 
        if (!char) return []
        
        // ZZZ 逻辑排序：普攻、闪避、特殊、连携、终结
        const TYPE_ORDER = { 'basic_attack': 1, 'dodge': 2, 'special_attack': 3, 'link': 4, 'ultimate': 5 }
        
        const standard = ['basic_attack', 'dodge', 'special_attack', 'link', 'ultimate'].map(type => {
            // 1. 处理普通攻击 (多段)
            if (type === 'basic_attack') {
                const segments = (char.basic_attack_segments || []).map((seg, i) => ({
                    id: `${char.id}_basic_seg${i + 1}`,
                    type: 'basic_attack',
                    name: seg.name || `A${i + 1}`,
                    kind: 'attack_segment',
                    ...seg,
                    duration: (Number(seg.duration) || 0) / 60,
                    damageTicks: seg.hit_ticks || [],
                    cancelWindows: seg.cancel_windows || {}
                }))
                return {
                    id: `${char.id}_basic`,
                    type: 'basic_attack',
                    name: getI18nSkillType('basic_attack'),
                    kind: 'attack_group',
                    attackSegments: segments.filter(s => s.duration > 0)
                }
            }
            
            // 2. 处理特殊技 (多段)
            if (type === 'special_attack') {
                const segments = (char.special_attack_segments || []).map((seg, i) => ({
                    id: `${char.id}_special_seg${i + 1}`,
                    type: 'special_attack',
                    name: `E${i + 1}`,
                    kind: 'attack_segment',
                    duration: Number(seg.duration) || 0,
                    damageTicks: seg.hit_ticks || [],
                    cancelWindows: seg.cancel_windows || {},
                    ...seg
                }))
                return {
                    id: `${char.id}_special`,
                    type: 'special_attack',
                    name: getI18nSkillType('special_attack'),
                    kind: 'attack_group',
                    attackSegments: segments.filter(s => s.duration > 0)
                }
            }

            // 3. 闪避/连携/终结技 (单段)
            const suffix = type;
            const data = char[suffix] || {};
            return {
                id: `${char.id}_${type}`,
                type,
                name: getI18nSkillType(type),
                duration: data.duration || 1,
                damageTicks: data.hit_ticks || [],
                cancelWindows: data.cancel_windows || { combo: 0, dodge: 0, skill: 0, swap: 0 }
            }
        })

    const variants = (char.variants || []).map(v => ({
            ...v,
            duration: (Number(v.duration) || 0) / 60,
            damageTicks: v.hit_ticks || [],
            cancelWindows: v.cancel_windows || []
        }))

        return [...standard, ...variants].sort((a, b) => (TYPE_ORDER[a.type] || 99) - (TYPE_ORDER[b.type] || 99))
    })

    function setTimelineShift(v) { timelineShift.value = Math.min(Math.max(0, v), totalTimelineWidthPx.value - timelineRect.value.width) }
    function selectTrack(tid) { activeTrackId.value = tid; clearSelection() }
    
    function clearSelection() { 
        selectedActionId.value = selectedAnomalyId.value = selectedCycleBoundaryId.value = selectedSwitchEventId.value = null; 
        multiSelectedIds.value.clear(); 
        selectedLibrarySkillId.value = null; 
        selectedLibrarySource.value = 'character' 
    }

    function normalizeComboLinksInTracks() {
        const groups = new Map(); tracks.value.forEach(t => t.actions.forEach(a => { if (a.comboGroupId) { if (!groups.has(a.comboGroupId)) groups.set(a.comboGroupId, []); groups.get(a.comboGroupId).push(a) } }))
        groups.forEach(actions => {
            const sorted = actions.sort((a, b) => (Number(a.comboSegmentIndex) || 0) - (Number(b.comboSegmentIndex) || 0))
            const linked = sorted.every(a => a.comboLinked !== false)
            sorted.forEach((a, i) => { a.comboLinked = linked; a.comboSegmentTotal = sorted.length; a.comboPrevId = i > 0 ? sorted[i - 1].instanceId : null; a.comboNextId = i < sorted.length - 1 ? sorted[i + 1].instanceId : null; if (linked) a.comboFollowupDelay = i === sorted.length - 1 ? 0 : snapMs(Math.max(0, Number(a.comboFollowupDelay) || 0)) })
        })
    }

    function addSkillToTrack(tid, skill, start) {
        const t = tracks.value.find(x => x.id === tid); if (!t) return
        const createAction = (s, st) => {
            const eidMap = new Map(); const anomalies = (s.physicalAnomaly || []).map(row => row.map(eff => { const nid = uid(); if (eff?._id) eidMap.set(eff._id, nid); return { ...eff, _id: nid } }))
            const ticks = (s.damageTicks || []).map(tk => ({ ...tk, boundEffects: (tk.boundEffects || []).map(id => eidMap.get(id) || id) }))
            return { ...s, instanceId: `inst_${uid()}`, librarySource: s.librarySource || 'character', physicalAnomaly: anomalies, damageTicks: ticks, logicalStartTime: st, startTime: st }
        }
        if (skill.segments?.length >= 2) {
            const gid = `combo_${uid()}`; let cur = start; const ins = []
            skill.segments.forEach((seg, i) => { const a = createAction({ ...skill, ...seg }, cur); a.comboGroupId = gid; a.comboSegmentIndex = i + 1; a.comboLinked = true; ins.push(a); cur = snapMs(a.startTime + a.duration + (a.comboFollowupDelay || 0)) })
            t.actions.push(...ins); normalizeComboLinksInTracks()
        } else if (skill.kind === 'attack_group') {
            let cur = start; skill.attackSegments.forEach((seg, i) => { const a = createAction(seg, cur); a.attackGroupInstanceId = `atkgrp_${uid()}`; a.attackSequenceIndex = i + 1; a.attackSequenceTotal = skill.attackSegments.length; t.actions.push(a); cur += a.duration })
        } else t.actions.push(createAction(skill, start))
        t.actions.sort((a, b) => a.startTime - b.startTime); if (['link', 'ultimate'].includes(skill.type)) pushSubsequentActions(start, skill.type === 'link' ? 0.5 : (Number(skill.animationTime) || 1.5), t.actions[t.actions.length - 1].instanceId)
        commitState()
    }

    function moveTrack(fromIndex, toIndex) {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= tracks.value.length || toIndex >= tracks.value.length) {
            return
        }
        const temp = tracks.value[fromIndex]
        tracks.value[fromIndex] = tracks.value[toIndex]
        tracks.value[toIndex] = temp
        commitState()
    }

    function selectLibrarySkill(skillId, source = 'character') {
        const normalizedSource = source || 'character'
        const isSame = (selectedLibrarySkillId.value === skillId && selectedLibrarySource.value === normalizedSource)
        if (skillId) {
            clearSelection()
            if (!isSame) {
                selectedLibrarySkillId.value = skillId
                selectedLibrarySource.value = normalizedSource
            } else {
                selectedLibrarySource.value = normalizedSource
            }
        } else {
            selectedLibrarySkillId.value = null
            selectedLibrarySource.value = normalizedSource
        }
    }

    function selectAction(instanceId) {
        const isSame = (instanceId === selectedActionId.value)
        clearSelection()
        if (!isSame) {
            selectedActionId.value = instanceId
            multiSelectedIds.value.add(instanceId)
        }
    }

    function removeCurrentSelection() {
        const targets = new Set(multiSelectedIds.value); if (selectedActionId.value) targets.add(selectedActionId.value)
        targets.forEach(id => { const a = getActionById(id)?.node; if (a?.comboGroupId && a.comboLinked !== false) tracks.value.forEach(t => t.actions.forEach(x => { if (x.comboGroupId === a.comboGroupId) targets.add(x.instanceId) })) })
        const pulls = []; targets.forEach(id => { const a = getActionById(id)?.node; if (a && ['link', 'ultimate'].includes(a.type)) pulls.push({ time: a.startTime, amount: a.type === 'link' ? 0.5 : (Number(a.animationTime) || 1.5) }) })
        if (selectedSwitchEventId.value) switchEvents.value = switchEvents.value.filter(s => s.id !== selectedSwitchEventId.value)
        if (selectedCycleBoundaryId.value) cycleBoundaries.value = cycleBoundaries.value.filter(b => b.id !== selectedCycleBoundaryId.value)
        tracks.value.forEach(t => { t.actions = t.actions.filter(a => !targets.has(a.instanceId)) })
        pulls.sort((a, b) => b.time - a.time).forEach(p => pullSubsequentActions(p.time, p.amount))
        clearSelection(); commitState()
    }

    function updateAction(id, patch) {
        const wrap = getActionById(id); if (!wrap) return
        Object.assign(wrap.node, patch); if (patch.startTime !== undefined) wrap.node.logicalStartTime = wrap.node.startTime
        if (wrap.node.comboGroupId) normalizeComboLinksInTracks()
        refreshAllActionShifts(); tracks.value[wrap.trackIndex].actions.sort((a, b) => a.startTime - b.startTime); commitState()
    }

    const nodeRects = computed(() => {
        const rects = {}; const BORDER = 2; const GAP = 6; const H = 2
        actionMap.value.forEach(action => {
            const start = action.node.startTime || 0; const end = getShiftedEndTime(start, action.node.duration, action.id)
            const left = timeToPx(start); const width = Math.max(2, timeToPx(end) - left)
            const tRect = trackLaneRects.value[action.trackIndex]; const top = (tRect ? tRect.top : 0) - timelineRect.value.top
            const rect = { left, width, right: left + width, height: tRect?.height ?? 0, top }
            const tw = Math.round(Math.abs(action.node.triggerWindow || 0) * 10) / 10
            const relY = BORDER + GAP - H / 2; const barY = rect.top + rect.height + relY - BORDER
            rects[action.id] = { rect, bar: { top: barY, relativeY: relY, leftEdge: -BORDER, rightEdge: -BORDER + width + BORDER }, triggerWindow: tw > 0 ? { rect: { left: left - BORDER - (timeToPx(start) - timeToPx(Math.max(0, start - tw))), right: left - BORDER, top: barY, height: H, width: timeToPx(start) - timeToPx(Math.max(0, start - tw)) }, hasWindow: true } : { hasWindow: false } }
        })
        return rects
    })

    const effectLayouts = computed(() => {
        const layouts = new Map();
        const SIZE = 20; const MARGIN = 2; const VGAP = 3; const BORDER = 2
        actionMap.value.forEach(action => {
            const aRect = nodeRects.value[action.id]?.rect; if (!aRect || !action.node.physicalAnomaly) return
            const rows = Array.isArray(action.node.physicalAnomaly[0]) ? action.node.physicalAnomaly : [action.node.physicalAnomaly]
            let flatIdx = 0; rows.forEach((row, ri) => row.forEach((eff, ci) => {
                const eid = ensureEffectId(eff); const mid = flatIdx++; const start = getShiftedEndTime(action.node.startTime, eff.offset || 0, action.id)
                const left = timeToPx(start); const relY = (ri * (VGAP + SIZE)) + VGAP + BORDER
                const iconRect = { left: left + 1, width: SIZE, right: left + 1 + SIZE, height: SIZE, top: aRect.top - relY - SIZE + BORDER }
                let dur = getShiftedEndTime(start, eff.duration, action.id) - start;
                const bWidth = dur > 0 ? Math.max(0, timeToPx(start + dur) - timeToPx(start) - SIZE - MARGIN) : 0
                layouts.set(eid, { rect: iconRect, localTransform: `translate(${left - aRect.left}px, ${-relY}px)`, barData: { width: bWidth, isConsumed: false, displayDuration: dur, extensionAmount: snapMs(dur - eff.duration) }, data: eff, actionId: action.id, flatIndex: mid })
            }))
        })
        return layouts
    })

    function toTimelineSpace(vx, vy) { return { x: vx - timelineRect.value.left + timelineShift.value, y: vy - timelineRect.value.top + timelineScrollTop.value } }
    function toViewportSpace(tx, ty) { return { x: tx - timelineShift.value + timelineRect.value.left, y: ty - timelineScrollTop.value + timelineRect.value.top } }

    const globalExtensions = computed(() => {
        const sources = []; tracks.value.forEach(t => t.actions.forEach(a => { if (!a.isDisabled && (a.triggerWindow || 0) >= 0 && ['link', 'ultimate'].includes(a.type)) sources.push({ logicalTime: a.logicalStartTime ?? a.startTime, startTime: a.startTime, type: a.type, instanceId: a.instanceId, animationTime: Number(a.animationTime) || 1.5 }) }))
        sources.sort((a, b) => a.logicalTime - b.logicalTime); const exts = []; let cum = 0
        sources.forEach((s, i) => { let amt = s.type === 'ultimate' ? s.animationTime : (sources[i + 1] ? Math.min(0.5, Math.max(0.1, snapMs(sources[i + 1].logicalTime - s.logicalTime))) : 0.5); exts.push({ time: s.startTime, gameTime: s.startTime - cum, amount: amt, sourceId: s.instanceId, logicalTime: s.logicalTime, cumulativeFreezeTime: cum }); cum += amt })
        return exts
    })

    function refreshAllActionShifts(exclude = []) {
        const exSet = new Set(Array.isArray(exclude) ? exclude : [exclude]); const all = tracks.value.flatMap(t => t.actions).sort((a, b) => (a.logicalStartTime ?? a.startTime) - (b.logicalStartTime ?? b.startTime))
        const stops = all.filter(a => ['link', 'ultimate'].includes(a.type) && !a.isDisabled && (a.triggerWindow || 0) >= 0)
        let lastPhysEnd = 0; const shiftMap = new Map(); stops.forEach((s, i) => { const next = stops[i + 1]; const pStart = Math.max(s.logicalStartTime, lastPhysEnd); let amt = s.type === 'ultimate' ? (Number(s.animationTime) || 1.5) : (next ? Math.min(0.5, Math.max(0.1, snapMs(next.logicalTime - s.logicalTime))) : 0.5); shiftMap.set(s.instanceId, { shift: pStart - s.logicalTime, pStart, pEnd: pStart + amt }); lastPhysEnd = pStart + amt })
        all.forEach(a => { if (exSet.has(a.instanceId)) return; const s = [...stops].reverse().find(x => x.logicalStartTime <= a.logicalStartTime); if (s) { const ctx = shiftMap.get(s.instanceId); a.startTime = snapMs(a.instanceId === s.instanceId ? ctx.pStart : Math.max(a.logicalStartTime + ctx.shift, ctx.pEnd)) } else a.startTime = a.logicalStartTime })
        tracks.value.forEach(t => t.actions.sort((a, b) => a.startTime - b.startTime))
    }

    function getShiftedEndTime(start, dur, exclude = null) {
        let limit = start + dur; const processed = new Set(); let changed = true
        while (changed) { changed = false; globalExtensions.value.forEach(e => { if (e.sourceId !== exclude && !processed.has(e.sourceId) && e.time >= start && e.time < limit) { limit += e.amount; processed.add(e.sourceId); changed = true } }) }
        return limit
    }

    function toGameTime(real) {
        const exts = globalExtensions.value; for (const e of exts) { const fStart = e.gameTime + e.cumulativeFreezeTime; if (real >= fStart && real < fStart + e.amount) return e.gameTime; if (real < fStart) return real - e.cumulativeFreezeTime }
        const last = exts[exts.length - 1]; return last ? real - (last.cumulativeFreezeTime + last.amount) : real
    }

    function toRealTime(game) {
        const bp = globalExtensions.value.toReversed().find(e => e.gameTime <= game); if (!bp) return game
        return game === bp.gameTime ? game + bp.cumulativeFreezeTime : game + bp.cumulativeFreezeTime + bp.amount
    }

    function pushSubsequentActions(trig, amt, exclude = []) { const exSet = new Set(Array.isArray(exclude) ? exclude : [exclude]); tracks.value.forEach(t => { t.actions.forEach(a => { if (!exSet.has(a.instanceId) && a.startTime >= trig) { a.startTime += amt; a.logicalStartTime = (a.logicalStartTime !== undefined ? a.logicalStartTime + amt : a.startTime) } }); t.actions.sort((a, b) => a.startTime - b.startTime) }) }
    function pullSubsequentActions(trig, amt, exclude = []) { if (amt <= 0) return; const exSet = new Set(Array.isArray(exclude) ? exclude : [exclude]); tracks.value.forEach(t => { t.actions.forEach(a => { if (!exSet.has(a.instanceId) && a.startTime >= trig) { a.startTime = Math.max(0, a.startTime - amt); a.logicalStartTime = Math.max(0, a.logicalStartTime !== undefined ? a.logicalStartTime - amt : a.startTime) } }); t.actions.sort((a, b) => a.startTime - b.startTime) }) }

    async function fetchGameData() {
        try { 
            isLoading.value = true; 
            const d = await executeFetch(); 
            if (d) { 
                if (d.characterRoster) {
                    characterRoster.value = d.characterRoster.map(c => { 
                        if (!c.rarity) c.rarity = c.rank === 'S' ? 6 : 5;
                        normalizeAttackSegmentsForCharacter(c); 
                        return c 
                    }).sort((a, b) => b.rarity - a.rarity); 
                }
                iconDatabase.value = d.ICON_DATABASE || {}; 
            } 
            historyStack.value = []; 
            historyIndex.value = -1; 
            commitState(); 
        } catch (e) { 
            console.error(e) 
        } finally { 
            isLoading.value = false 
        }
    }
    function setMultiSelection(idsArray) {
        multiSelectedIds.value = new Set(idsArray)
        if (idsArray.length === 1) { selectedActionId.value = idsArray[0] } else { selectedActionId.value = null }
    }
    function setSelectedAnomalyId(id) { selectedAnomalyId.value = id }
    function setHoveredAction(id) { hoveredActionId.value = id }
    function nudgeSelection(dir) { /* stub */ }
    function setPrepDuration(val, { commit = true } = {}) {
        prepDuration.value = Math.max(MIN_PREP_DURATION, Number(val) || 0)
        if (commit) commitState()
    }
    function setTrackLaneRect(index, rect) { trackLaneRects.value[index] = rect }
    function setTimelineRect(width, height, top, right, bottom, left) { timelineRect.value = { width, height, top, right, bottom, left } }
    function setScrollTop(top) { timelineScrollTop.value = top }
    function togglePrepExpanded() { prepExpanded.value = !prepExpanded.value; commitState() }
    function setCursorPosition(x, y) { cursorPosition.value = { x, y } }
    function toggleCursorGuide() { showCursorGuide.value = !showCursorGuide.value }
    function toggleBoxSelectMode() { isBoxSelectMode.value = !isBoxSelectMode.value }
    function toggleSnapStep() { snapStep.value = snapStep.value < 0.1 ? 0.1 : 0.05 }
    function toggleNewCompiler() { /* stub */ }

    const contextMenu = ref({ visible: false, x: 0, y: 0, targetId: null, clickTime: 0 })
    function closeContextMenu() { contextMenu.value.visible = false }
    function openContextMenu(evt, targetId = null, clickTime = 0) {
        evt.preventDefault()
        contextMenu.value = { visible: true, x: evt.clientX, y: evt.clientY, targetId, clickTime }
    }

    return {
        setTrackLaneRect, setTimelineRect, setScrollTop, contextMenu, closeContextMenu, openContextMenu,
        togglePrepExpanded, setCursorPosition, toggleCursorGuide, toggleBoxSelectMode, toggleSnapStep, toggleNewCompiler,
        
        MAX_SCENARIOS, toTimelineSpace, toViewportSpace, toGameTime, toRealTime,
        systemConstants, isLoading, characterRoster, iconDatabase, tracks, activeTrackId, timelineScrollTop, timelineShift, timelineRect, trackLaneRects, nodeRects, draggingSkillData,
        selectedActionId, selectedLibrarySkillId, selectedLibrarySource, multiSelectedIds, clipboard, isCapturing, setIsCapturing, showCursorGuide, isBoxSelectMode, cursorPosTimeline, cursorCurrentTime, cursorPosition, snapStep,
        selectedAnomalyId, setSelectedAnomalyId, updateTrackGaugeEfficiency,
        teamTracksInfo, activeSkillLibrary, BASE_BLOCK_WIDTH, setBaseBlockWidth, formatTimeLabel, ZOOM_LIMITS, timeBlockWidth, ELEMENT_COLORS, getCharacterElementColor, isActionSelected, hoveredActionId, setHoveredAction,
        fetchGameData, TOTAL_DURATION, selectTrack, clearSelection, undo, redo, commitState, addSkillToTrack, removeCurrentSelection, updateAction,
        getModifierLabel, getColor, nudgeSelection,
        ENEMY_TIERS,
        scenarioList, activeScenarioId, switchScenario, addScenario, duplicateScenario, deleteScenario,
        effectLayouts, getActionById, getEffectById, prepDuration, prepExpanded, viewDuration, prepZoneWidthPx, totalTimelineWidthPx,
        timeToPx, pxToTime, formatAxisTimeLabel, setPrepDuration,
        globalExtensions, getShiftedEndTime, refreshAllActionShifts,

        isCharacterInTeam, changeTrackOperator, clearTrackOperator, moveTrack, setDraggingSkill, selectAction, selectLibrarySkill, setMultiSelection
    }
})