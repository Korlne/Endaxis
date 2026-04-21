<script setup>
import { ref, provide, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { refThrottled } from '@vueuse/core'
import { useTimelineStore } from '../stores/timelineStore.js'
import ActionItem from './ActionItem.vue'
import GaugeOverlay from './GaugeOverlay.vue'
import ContextMenu from './ContextMenu.vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const store = useTimelineStore()
const { t, locale } = useI18n()

// ===================================================================================
// 初始化与常量
// ===================================================================================

const TIME_BLOCK_WIDTH = computed(() => store.timeBlockWidth)
provide('TIME_BLOCK_WIDTH', TIME_BLOCK_WIDTH)

const tracksContentRef = ref(null)
const timeRulerWrapperRef = ref(null)
const tracksHeaderRef = ref(null)
const trackLaneRefs = ref([])

const svgRenderKey = ref(0)
const scrollbarHeight = ref(0)
const isCursorVisible = ref(false)

// Drag State
const isMouseDown = ref(false)
const isDragStarted = ref(false)
const movingActionId = ref(null)
const movingTrackId = ref(null)
const initialMouseX = ref(0)
const initialMouseY = ref(0)
const dragThreshold = 5
const wasSelectedOnPress = ref(false)
const dragStartTimes = new Map()
const isAltDown = ref(false)
const isShiftDown = ref(false)
const hoveredContext = ref(null)
const draggingCycleBoundaryId = ref(null)
const draggingSwitchEventId = ref(null)
const dragStartMouseTime = ref(0)

const autoScrollSpeed = ref(0)
let autoScrollRaf = null
let lastMouseX = 0
const SCROLL_ZONE = 50
const MAX_SCROLL_SPEED = 15

const TRACK_HEIGHT = 50

const isBoxSelecting = ref(false)
const boxStart = ref({ x: 0, y: 0 })
const boxRect = ref({ left: 0, top: 0, width: 0, height: 0 })

const draggingTrackOrderIndex = ref(null)
const reorderDropTargetIndex = ref(null)

function onReorderDragStart(evt, index) {
  draggingTrackOrderIndex.value = index
  evt.dataTransfer.effectAllowed = 'move'
  const trackInfoEl = evt.target.closest('.track-info')
  if (trackInfoEl) {
    const rect = trackInfoEl.getBoundingClientRect()
    evt.dataTransfer.setDragImage(trackInfoEl, evt.clientX - rect.left, evt.clientY - rect.top)
  }
}

function onReorderDragOver(evt, index) {
  if (draggingTrackOrderIndex.value === null) return
  evt.preventDefault() 
  evt.dataTransfer.dropEffect = 'move'
  reorderDropTargetIndex.value = index
}

function onReorderDrop(evt, targetIndex) {
  evt.preventDefault()
  if (draggingTrackOrderIndex.value !== null && draggingTrackOrderIndex.value !== targetIndex) {
    store.moveTrack(draggingTrackOrderIndex.value, targetIndex)
  }
  resetReorderState()
}

function onReorderDragEnd() { resetReorderState() }
function resetReorderState() { draggingTrackOrderIndex.value = null; reorderDropTargetIndex.value = null }
function moveTrackUp(index) { if (index > 0) store.moveTrack(index, index - 1) }
function moveTrackDown(index) { if (index < store.tracks.length - 1) store.moveTrack(index, index + 1) }

// ===================================================================================
// 干员选择弹窗逻辑
// ===================================================================================

const isSelectorVisible = ref(false)
const targetTrackIndex = ref(null)
const searchQuery = ref('')
const filterCharacteristic = ref('ALL')

const isGameTimeCollapsed = ref(true)
const showGameTime = computed(() => !isGameTimeCollapsed.value || store.isCapturing)
const gridRowHeight = computed(() => showGameTime.value ? '60px' : '48px')

const CHARACTERISTIC_FILTERS = computed(() => [
  { label: '全部', value: 'ALL' },
  { label: '强攻', value: 'Attack' },
  { label: '击破', value: 'Break' },
  { label: '异常', value: 'Anomaly' },
  { label: '支援', value: 'Support' },
  { label: '防护', value: 'Defense' },
  { label: '命破', value: 'Rupture' }
])

function openCharacterSelector(index) {
  targetTrackIndex.value = index; searchQuery.value = ''; filterCharacteristic.value = 'ALL'; isSelectorVisible.value = true
}

function confirmCharacterSelection(charId) {
  if (targetTrackIndex.value !== null) store.changeTrackOperator(targetTrackIndex.value, store.tracks[targetTrackIndex.value].id, charId)
  isSelectorVisible.value = false
}

function removeOperator() {
  if (targetTrackIndex.value !== null) store.clearTrack(targetTrackIndex.value)
  isSelectorVisible.value = false
}

const filteredListFlat = computed(() => {
  let list = store.characterRoster || []
  if (filterCharacteristic.value !== 'ALL') {
    list = list.filter(c => c.characteristic === filterCharacteristic.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(c => c.name.toLowerCase().includes(q))
  }
  return list.sort((a, b) => (b.rarity || 0) - (a.rarity || 0))
})

const rosterByRarity = computed(() => {
  const groups = {}
  filteredListFlat.value.forEach(char => {
    const r = char.rarity || 1
    if (!groups[r]) groups[r] = []
    groups[r].push(char)
  })
  return Object.keys(groups).map(Number).sort((a, b) => b - a).map(level => ({ level, list: groups[level] }))
})

function getRarityBaseColor(rarity) {
  const colors = { 6: '#FFD700', 5: '#ffc400', 4: '#d8b4fe' }
  return colors[rarity] || '#a0a0a0'
}

// ===================================================================================
// 核心逻辑：操作轴与刻度 (高性能版)
// ===================================================================================

const operationMarkers = computed(() => {
  let rawMarkers = []
  store.tracks.forEach((track, index) => {
    if (!track.id) return
    const keyNum = index + 1
    track.actions.forEach(action => {
      if ((action.triggerWindow || 0) < 0) return
      let label = '', isHold = false, customClass = ''
      if (action.type === 'skill') { label = `${keyNum}`; customClass = 'op-skill' }
      else if (action.type === 'link') { label = 'E'; customClass = 'op-link' }
      else if (action.type === 'ultimate') { label = `${keyNum} (Hold)`; isHold = true; customClass = 'op-ultimate' }
      else return

      rawMarkers.push({
        id: `op-${action.instanceId}`,
        left: store.timeToPx(action.startTime || 0),
        width: isHold ? null : 24,
        right: store.timeToPx(action.startTime || 0) + (isHold ? (store.timeToPx((action.startTime || 0) + (action.duration || 0)) - store.timeToPx(action.startTime || 0)) : 24),
        label, isHold, customClass, top: 0, height: 14, fontSize: 9
      })
    })

    const mySwitchEvents = (store.switchEvents || []).filter(sw => sw.characterId === track.id)
    mySwitchEvents.forEach(sw => {
      rawMarkers.push({ id: `op-sw-${sw.id}`, left: store.timeToPx(sw.time), width: 24, right: store.timeToPx(sw.time) + 24, label: `F${keyNum}`, isHold: false, customClass: 'op-switch', top: 0, height: 14, fontSize: 9 })
    })
  })

  rawMarkers.sort((a, b) => a.left - b.left)
  const finalMarkers = []
  let cluster = [], clusterMaxRight = -1
  const processCluster = (group) => {
    if (!group.length) return
    const levels = []
    group.forEach(m => {
      let placed = false
      for (let i = 0; i < levels.length; i++) { if (levels[i] + 1 <= m.left) { m.rowIndex = i; levels[i] = m.right; placed = true; break } }
      if (!placed) { m.rowIndex = levels.length; levels.push(m.right) }
    })
    const depth = levels.length
    let h = depth <= 2 ? 14 : (depth === 3 ? 12 : 10)
    let step = depth <= 2 ? 16 : (depth === 3 ? 13 : 10)
    let fs = depth <= 3 ? 9 : 8
    group.forEach(m => { m.height = h; m.top = m.rowIndex * step; m.fontSize = fs; finalMarkers.push(m) })
  }
  rawMarkers.forEach(m => {
    if (!cluster.length) { cluster.push(m); clusterMaxRight = m.right }
    else if (m.left < clusterMaxRight) { cluster.push(m); clusterMaxRight = Math.max(clusterMaxRight, m.right) }
    else { processCluster(cluster); cluster = [m]; clusterMaxRight = m.right }
  })
  processCluster(cluster)
  return finalMarkers
})

function getViewWindow({ bufferPx = 0 } = {}) {
  const totalPx = store.totalTimelineWidthPx
  const totalSeconds = store.viewDuration
  
  if (!store.timelineRect.width || store.isCapturing) {
    return { startPx: 0, endPx: totalPx, startTime: 0, endTime: totalSeconds }
  }

  const scrollLeft = store.timelineShift
  const timelineWidth = store.timelineRect.width
  const startPx = Math.max(scrollLeft - bufferPx, 0)
  const endPx = Math.min(scrollLeft + timelineWidth + bufferPx, totalPx)

  return {
    startPx, endPx,
    startTime: store.pxToTime(startPx),
    endTime: store.pxToTime(endPx)
  }
}

const rawDynamicTicks = computed(() => {
  const width = TIME_BLOCK_WIDTH.value
  const viewWindow = getViewWindow({ bufferPx: 100 })
  const realTicks = []

  let subDivision = 1
  if (width >= 800) subDivision = 60
  else if (width >= 200) subDivision = 10
  else if (width >= 100) subDivision = 2

  const startStep = Math.floor(viewWindow.startTime * subDivision)
  const endStep = Math.ceil(viewWindow.endTime * subDivision)

  for (let i = startStep; i <= endStep; i++) {
    const time = i / subDivision
    if (time < 0) continue

    let type = '', label = ''
    const isIntegerSecond = i % subDivision === 0

    if (isIntegerSecond) {
      const secondValue = Math.round(time)
      const isFiveSec = secondValue % 5 === 0
      if (width >= 100 || isFiveSec) {
        type = 'major'; label = `${secondValue}s`
      } else {
        type = 'major-dim'
      }
    } else {
      if (subDivision === 2) {
        type = 'tenth'
      } else if (subDivision === 10) {
        type = 'tenth'
        if (width >= 500) label = `.${Math.round((time % 1) * 10)}`
      } else if (subDivision === 60) {
        const frameIdx = i % 60
        if (frameIdx % 10 === 0 && frameIdx !== 0) {
          type = 'tenth'
          if (width >= 600) label = `${frameIdx}f`
        } else if (frameIdx % 2 === 0) {
          type = 'frame'
        } else {
          if (width < 1000) continue
          type = 'frame'
        }
      } else {
        continue
      }
    }

    realTicks.push({ time, type, label, x: store.timeToPx(time) })
  }
  return { realTicks }
})

const dynamicTicks = rawDynamicTicks

// ===================================================================================
// 基础 UI 逻辑
// ===================================================================================

function forceSvgUpdate() { svgRenderKey.value++ }
function updateScrollbarHeight() {
  if (tracksContentRef.value) {
    const el = tracksContentRef.value
    scrollbarHeight.value = Math.max(0, el.offsetHeight - el.clientHeight)
  }
}

function calculateTimeFromEvent(evt) { return Math.max(0, store.pxToTime(store.toTimelineSpace(evt.clientX, evt.clientY).x)) }

const fakeScrollbarRef = ref(null)
let ticking = false
function onFakeScroll(e) {
  if (ticking) return
  ticking = true; store.setTimelineShift(e.target.scrollLeft)
  requestAnimationFrame(() => { ticking = false })
}

watch(() => store.timelineShift, (val) => { if (fakeScrollbarRef.value) fakeScrollbarRef.value.scrollLeft = val })
watch(() => store.timelineScrollTop, (val) => {
  if (tracksHeaderRef.value) tracksHeaderRef.value.scrollTop = val
  if (tracksContentRef.value && Math.abs(tracksContentRef.value.scrollTop - val) > 1) tracksContentRef.value.scrollTop = val
})

function syncVerticalScroll() { if (tracksContentRef.value) store.setScrollTop(tracksContentRef.value.scrollTop) }

// ===================================================================================
// 交互与拖拽
// ===================================================================================

const cachedSpData = computed(() => store.calculateGlobalSpData())
const currentSpValue = computed(() => {
  const time = store.cursorCurrentTime; const points = cachedSpData.value
  if (!points?.length) return Math.floor(Number(store.systemConstants.initialSp) || 200)
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i+1]
    if (time >= p1.time && time < p2.time) return Math.floor(p1.sp + (p2.sp - p1.sp) * ((time - p1.time) / (p2.time - p1.time)))
  }
  return Math.floor(points[points.length - 1].sp)
})

const cachedStaggerData = computed(() => store.calculateGlobalStaggerData().points)
const currentStaggerValue = computed(() => {
  const time = store.cursorCurrentTime; const points = cachedStaggerData.value
  if (!points?.length) return 0
  for (let i = 0; i < points.length - 1; i++) { if (time >= points[i].time && time < points[i+1].time) return Math.floor(points[i].val) }
  return Math.floor(points[points.length - 1].val)
})

function onGridMouseMove(evt) { store.setCursorPosition(evt.clientX, evt.clientY); isCursorVisible.value = true }
function onGridMouseLeave() { isCursorVisible.value = false }

function onContentMouseDown(evt) {
  if (store.isBoxSelectMode) {
    evt.stopPropagation(); evt.preventDefault(); isBoxSelecting.value = true
    boxStart.value = store.toTimelineSpace(evt.clientX, evt.clientY)
    boxRect.value = { left: boxStart.value.x, top: boxStart.value.y, width: 0, height: 0 }
    window.addEventListener('mousemove', onBoxMouseMove); window.addEventListener('mouseup', onBoxMouseUp); return
  }
  if (evt.target === tracksContentRef.value || evt.target.classList.contains('track-row')) store.selectTrack(null)
}

function onCycleLineMouseDown(evt, boundaryId) {
  evt.stopPropagation(); if (store.selectedCycleBoundaryId !== boundaryId) store.selectCycleBoundary(boundaryId)
  draggingCycleBoundaryId.value = boundaryId; initialMouseX.value = evt.clientX; initialMouseY.value = evt.clientY
  isDragStarted.value = false; isMouseDown.value = true
  window.addEventListener('mousemove', onWindowMouseMove); window.addEventListener('mouseup', onWindowMouseUp)
}

function onBoxMouseMove(evt) {
  const curr = store.toTimelineSpace(evt.clientX, evt.clientY)
  boxRect.value = { left: Math.min(boxStart.value.x, curr.x), top: Math.min(boxStart.value.y, curr.y), width: Math.abs(curr.x - boxStart.value.x), height: Math.abs(curr.y - boxStart.value.y) }
}

function onBoxMouseUp() {
  isBoxSelecting.value = false; window.removeEventListener('mousemove', onBoxMouseMove); window.removeEventListener('mouseup', onBoxMouseUp)
  const box = boxRect.value, foundIds = []
  store.tracks.forEach((track, trackIdx) => {
    const el = document.getElementById(`track-row-${trackIdx}`)
    if (!el) return
    const tRect = el.getBoundingClientRect(), cRect = store.timelineRect, tTop = (tRect.top - cRect.top) + store.timelineScrollTop
    if (tTop + tRect.height >= box.top && tTop <= box.top + box.height) {
      track.actions.forEach(a => { if (store.timeToPx(a.startTime) < box.left + box.width && store.timeToPx(a.startTime + (a.duration || 0)) > box.left) foundIds.push(a.instanceId) })
    }
  })
  if (foundIds.length) store.setMultiSelection(foundIds); else store.clearSelection()
  boxRect.value = { left: 0, top: 0, width: 0, height: 0 }
}

const zoomValue = computed({ get: () => store.timeBlockWidth, set: (val) => store.setBaseBlockWidth(val) })

function adjustZoom(delta, anchorTime = null) {
  const oldWidth = store.timeBlockWidth
  if (anchorTime === null) anchorTime = store.pxToTime(store.timelineShift + store.timelineRect.width / 2)
  const offset = store.timeToPx(anchorTime) - store.timelineShift
  store.setBaseBlockWidth(oldWidth + delta)
  store.setTimelineShift(store.timeToPx(anchorTime) - offset)
}

function handleWheel(e) { if (e.ctrlKey) { e.preventDefault(); adjustZoom(e.deltaY < 0 ? Math.round(store.timeBlockWidth * 0.15) : -Math.round(store.timeBlockWidth * 0.15), store.cursorCurrentTime) } }
function handleTrackWheel(e) {
  if (ticking) return
  if (e.ctrlKey) return handleWheel(e)
  if (Math.abs(e.deltaX) > 0 || e.shiftKey) { e.preventDefault(); store.setTimelineShift(store.timelineShift + (e.shiftKey ? e.deltaY : e.deltaX)) }
}

const alignGuide = ref({ visible: false, x: 0, top: 0, height: 0, label: '', type: '', color: '', targetRect: null })
function updateAlignGuide(evt, action) {
  hoveredContext.value = { action, clientX: evt.clientX }
  if (!isAltDown.value || !store.selectedActionId || store.selectedActionId === action.instanceId) return alignGuide.value.visible = false
  const layout = store.getNodeRect(action.instanceId)
  if (!layout) return
  const isLeft = (store.toTimelineSpace(evt.clientX, evt.clientY).x - layout.rect.left) < (layout.rect.width / 2)
  alignGuide.value = { visible: true, x: isLeft ? layout.rect.left : layout.rect.left + layout.rect.width, top: layout.rect.top, height: layout.rect.height, label: isShiftDown.value ? (isLeft ? t('timelineGrid.alignGuide.alignLeft') : t('timelineGrid.alignGuide.alignRight')) : (isLeft ? t('timelineGrid.alignGuide.snapFront') : t('timelineGrid.alignGuide.snapBack')), color: isShiftDown.value ? '#ff00ff' : '#00e5ff', targetRect: layout.rect }
}
function hideAlignGuide() { alignGuide.value.visible = false; hoveredContext.value = null }

function onActionMouseDown(evt, track, action) {
  evt.stopPropagation(); if (action.isLocked && evt.button === 0) { store.selectAction(action.instanceId); ElMessage.warning({ message: t('timelineGrid.action.locked'), duration: 1000 }); return }
  if (isAltDown.value) {
    if (store.selectedActionId && store.selectedActionId !== action.instanceId) {
      const layout = store.getNodeRect(action.instanceId), isLeft = (store.toTimelineSpace(evt.clientX, evt.clientY).x - layout.rect.left) < (layout.rect.width / 2)
      store.alignActionToTarget(action.instanceId, isShiftDown.value ? (isLeft ? 'LL' : 'RR') : (isLeft ? 'RL' : 'LR'))
    }
    return
  }
  if (evt.button !== 0) return
  setTimeout(() => {
    if (!store.multiSelectedIds.has(action.instanceId)) store.selectAction(action.instanceId)
    isMouseDown.value = true; isDragStarted.value = false; movingActionId.value = action.instanceId; movingTrackId.value = track.id
    dragStartTimes.clear(); store.tracks.forEach(t => t.actions.forEach(a => dragStartTimes.set(a.instanceId, a.startTime)))
    initialMouseX.value = evt.clientX; dragStartMouseTime.value = store.pxToTime(store.toTimelineSpace(evt.clientX, evt.clientY).x)
    window.addEventListener('mousemove', onWindowMouseMove); window.addEventListener('mouseup', onWindowMouseUp)
  }, 0)
}

function updateDragPosition(clientX) {
  if (!isDragStarted.value || !movingActionId.value) return
  const deltaTime = Math.round(store.pxToTime(store.toTimelineSpace(clientX, 0).x) - dragStartMouseTime.value)
  store.tracks.forEach(t => t.actions.forEach(a => { if (store.multiSelectedIds.has(a.instanceId) && !a.isLocked) a.startTime = Math.max(0, Math.round(dragStartTimes.get(a.instanceId) + deltaTime)) }))
  store.refreshAllActionShifts(); nextTick(() => svgRenderKey.value++)
}

function onWindowMouseMove(evt) {
  if (draggingSwitchEventId.value || draggingCycleBoundaryId.value) {
    isDragStarted.value = true; const t = calculateTimeFromEvent(evt)
    if (draggingSwitchEventId.value) store.updateSwitchEvent(draggingSwitchEventId.value, t); else store.updateCycleBoundary(draggingCycleBoundaryId.value, t); return
  }
  if (!isMouseDown.value) return
  if (!isDragStarted.value) { if (Math.abs(evt.clientX - initialMouseX.value) > dragThreshold) isDragStarted.value = true; else return }
  lastMouseX = evt.clientX; const r = store.timelineRect
  autoScrollSpeed.value = evt.clientX < r.left + SCROLL_ZONE ? -MAX_SCROLL_SPEED : (evt.clientX > r.right - SCROLL_ZONE ? MAX_SCROLL_SPEED : 0)
  if (autoScrollSpeed.value !== 0 && !autoScrollRaf) autoScrollRaf = requestAnimationFrame(function scroll() {
    if (!autoScrollSpeed.value) return autoScrollRaf = null
    store.setTimelineShift(store.timelineShift + autoScrollSpeed.value); updateDragPosition(lastMouseX); autoScrollRaf = requestAnimationFrame(scroll)
  })
  if (!autoScrollSpeed.value) updateDragPosition(evt.clientX)
}

function onWindowMouseUp() {
  autoScrollSpeed.value = 0; if (isDragStarted.value) store.commitState()
  isMouseDown.value = isDragStarted.value = false; movingActionId.value = draggingSwitchEventId.value = draggingCycleBoundaryId.value = null
  window.removeEventListener('mousemove', onWindowMouseMove); window.removeEventListener('mouseup', onWindowMouseUp)
}

function onTrackDrop(track, evt) {
  const s = store.draggingSkillData; if (s && store.activeTrackId === track.id) store.addSkillToTrack(track.id, s, Math.max(0, Math.round(store.pxToTime(store.toTimelineSpace(evt.clientX - (Number(s.dragOffsetX) || 0), 0).x))))
}

function handleKeyDown(e) { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); store.removeCurrentSelection() } }

onMounted(() => {
  if (tracksContentRef.value) {
    tracksContentRef.value.addEventListener('scroll', syncVerticalScroll)
    new ResizeObserver(([entry]) => {
      const r = entry.target.getBoundingClientRect(); store.setTimelineRect(r.width, r.height, r.top, r.right, r.bottom, r.left)
      trackLaneRefs.value.forEach(ref => { const lr = ref.getBoundingClientRect(); store.setTrackLaneRect(ref.dataset.trackIndex, { top: lr.top, bottom: lr.bottom, left: lr.left, right: lr.right, width: lr.width, height: lr.height }) })
      forceSvgUpdate(); updateScrollbarHeight()
    }).observe(tracksContentRef.value)
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') isAltDown.value = true; if (e.key === 'Shift') isShiftDown.value = true; handleKeyDown(e) })
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { isAltDown.value = false; hideAlignGuide() } if (e.key === 'Shift') isShiftDown.value = false })
})
</script>

<template>
  <div class="timeline-grid-layout" :style="{ gridTemplateRows: `${gridRowHeight} 1fr` }">
    <div class="corner-placeholder">
      <div class="corner-controls">
        <div class="corner-zoom-row">
          <div class="zoom-info-line">
            <span class="zoom-label">SCALE</span>
            <span class="zoom-value">{{ Math.round((store.timeBlockWidth / 50) * 100) }}%</span>
          </div>
          <div class="zoom-slider-container">
            <input type="range" class="davinci-range" :min="store.ZOOM_LIMITS.MIN" :max="store.ZOOM_LIMITS.MAX" step="1" v-model.number="zoomValue" />
          </div>
        </div>
        
        <div class="corner-button-row">
          <button class="mini-tool-btn" :class="{ 'is-active': store.showCursorGuide }" @click="store.toggleCursorGuide" :title="t('timelineGrid.toolbar.cursorGuide')">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="6" x2="12" y2="18"></line><line x1="6" y1="12" x2="18" y2="12"></line></svg>
          </button>
          <button class="mini-tool-btn" :class="{ 'is-active': store.isBoxSelectMode }" @click="store.toggleBoxSelectMode" :title="t('timelineGrid.toolbar.boxSelect')">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 4"/><path d="M8 12h8" stroke-width="1.5"/><path d="M12 8v8" stroke-width="1.5"/></svg>
          </button>
          <button class="mini-tool-btn is-active"><span class="btn-text">1 Tick</span></button>
        </div>
      </div>
    </div>

    <div class="time-ruler-wrapper" ref="timeRulerWrapperRef" @click="store.selectTrack(null)">
      <div class="ruler-content-container" :style="transformStyle">
        <div class="time-ruler-track" :style="{ width: `${store.totalTimelineWidthPx}px` }">
          <div v-for="tick in dynamicTicks.realTicks" :key="tick.time" class="tick-line" :class="tick.type" :style="{ left: `${Math.round(tick.x)}px` }">
            <span v-if="tick.label" class="tick-label">{{ tick.label }}</span>
          </div>
        </div>
        <div class="operation-layer">
          <div v-for="op in operationMarkers" :key="op.id" class="key-cap" :class="op.customClass" :style="{ left: `${op.left}px`, top: `${op.top}px`, width: op.width ? `${op.width}px` : 'auto', height: `${op.height}px`, fontSize: `${op.fontSize}px` }">
            <span class="key-text">{{ op.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="tracks-header-sticky" ref="tracksHeaderRef" @click="store.selectTrack(null)" :style="{ paddingBottom: `${20 + scrollbarHeight}px` }">
      <div v-for="(track, index) in store.teamTracksInfo" :key="index" class="track-info" @click.stop="store.selectTrack(track.id)" :class="{ 'is-active': track.id === store.activeTrackId }" @dragover="onReorderDragOver($event, index)" @drop="onReorderDrop($event, index)">
        <div class="track-controls">
           <div class="reorder-btn arrow-btn up-btn" @click.stop="moveTrackUp(index)" :class="{ disabled: index === 0 }"><svg viewBox="0 0 24 24" width="10" height="10" stroke-width="3" fill="none"><polyline points="18 15 12 9 6 15"></polyline></svg></div>
           <div class="drag-handle" draggable="true" @dragstart="onReorderDragStart($event, index)"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="8" cy="4" r="2"></circle><circle cx="8" cy="12" r="2"></circle><circle cx="8" cy="20" r="2"></circle><circle cx="16" cy="4" r="2"></circle><circle cx="16" cy="12" r="2"></circle><circle cx="16" cy="20" r="2"></circle></svg></div>
           <div class="reorder-btn arrow-btn down-btn" @click.stop="moveTrackDown(index)" :class="{ disabled: index === store.tracks.length - 1 }"><svg viewBox="0 0 24 24" width="10" height="10" stroke-width="3" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg></div>
        </div>
        <div class="char-select-trigger" @click.stop="openCharacterSelector(index)">
          <div class="operator-row">
            <div class="trigger-avatar-box"><img v-if="track.id" :src="track.avatar" class="avatar-image" /><div v-else class="avatar-placeholder"></div></div>
            <div class="trigger-info"><span class="trigger-name">{{ track.name || t('timelineGrid.track.selectOperator') }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="tracks-content-viewport" ref="tracksContentRef" @mousedown="onContentMouseDown" @wheel="handleTrackWheel" @mousemove="onGridMouseMove" @mouseleave="onGridMouseLeave" @contextmenu.prevent="store.openContextMenu($event, null, Math.max(0, Math.round(store.pxToTime(store.toTimelineSpace($event.clientX, $event.clientY).x))))">
      <div class="tracks-content-scroller" :style="transformStyle">
        <div v-if="store.showCursorGuide && !store.isBoxSelectMode" class="cursor-guide" :style="{ transform: `translateX(${store.cursorPosTimeline.x}px)` }" v-show="isCursorVisible">
          <div class="guide-time-label">{{ Math.trunc(Math.round(store.cursorCurrentTime) / 60) }}s {{ Math.abs(Math.round(store.cursorCurrentTime) % 60) }}t</div>
        </div>
        <div v-for="boundary in store.cycleBoundaries" :key="boundary.id" class="cycle-guide" :class="{ 'is-selected': boundary.id === store.selectedCycleBoundaryId }" :style="{ left: `${store.timeToPx(boundary.time)}px` }" @mousedown="onCycleLineMouseDown($event, boundary.id)"></div>
        <div v-if="isBoxSelecting" class="selection-box-overlay" :style="{ left: `${boxRect.left}px`, top: `${boxRect.top}px`, width: `${boxRect.width}px`, height: `${boxRect.height}px` }"></div>
        <div class="tracks-content">
          <ContextMenu />
          <div v-for="(track, index) in store.tracks" :key="index" class="track-row" :id="`track-row-${index}`" :style="{ '--track-height': `${TRACK_HEIGHT}px` }" @dragover.prevent @drop="onTrackDrop(track, $event)">
            <div class="track-lane" :style="getTrackLaneStyle" ref="trackLaneRefs" :data-track-index="index">
              <GaugeOverlay v-if="track.id" :track-id="track.id"/>
              <div class="actions-container">
                <ActionItem v-for="action in track.actions" :key="action.instanceId" :action="action" @mousedown="onActionMouseDown($event, track, action)" @mousemove="updateAlignGuide($event, action)" @mouseleave="hideAlignGuide" @contextmenu.prevent.stop="store.openContextMenu($event, action.instanceId)" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="timeline-horizontal-scrollbar" ref="fakeScrollbarRef" @scroll="onFakeScroll"><div class="scrollbar-spacer" :style="{ width: `${store.totalTimelineWidthPx}px` }"></div></div>
    </div>

    <el-dialog v-model="isSelectorVisible" :title="t('timelineGrid.operatorDialog.title')" width="600px" align-center class="char-selector-dialog" :append-to-body="true">
      <div class="selector-header">
        <el-input v-model="searchQuery" :prefix-icon="Search" clearable style="width: 200px" />
        <button class="ea-btn ea-btn--glass-cut-danger" @click="removeOperator">{{ t('common.unequip') }}</button>
        <div class="element-filters">
          <button v-for="cls in CHARACTERISTIC_FILTERS" :key="cls.value" class="ea-btn ea-btn--glass-cut" :class="{ 'is-active': filterCharacteristic === cls.value }" @click="filterCharacteristic = cls.value">{{ cls.label }}</button>
        </div>
      </div>
      <div class="roster-scroll-container">
        <template v-for="group in rosterByRarity" :key="group.level">
          <div class="rarity-header" :style="{ color: getRarityBaseColor(group.level) }"><span>{{ group.level }} ★</span></div>
          <div class="roster-grid">
            <div v-for="char in group.list" :key="char.id" class="roster-card" @click="confirmCharacterSelection(char.id)">
              <div class="card-avatar-wrapper"><img :src="char.avatar" /></div>
              <div class="card-name">{{ char.name }}</div>
            </div>
          </div>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.timeline-grid-layout { display: grid; grid-template-columns: 180px 1fr; grid-template-rows: 60px 1fr; width: 100%; height: 100%; overflow: hidden; user-select: none; }

.corner-placeholder { 
  background: #3a3a3a; border-bottom: 1px solid #444; border-right: 1px solid #444; padding: 6px; 
  display: flex; flex-direction: column; justify-content: center; gap: 4px; position: relative; z-index: 100;
}

.corner-zoom-row { background: rgba(0,0,0,0.2); padding: 4px 6px; border-radius: 4px; margin-bottom: 2px; }
.zoom-info-line { display: flex; justify-content: space-between; font-size: 10px; color: #aaa; margin-bottom: 2px; font-weight: bold; }
.zoom-slider-container { display: flex; align-items: center; }
.davinci-range { width: 100%; height: 4px; -webkit-appearance: none; background: #555; border-radius: 2px; outline: none; cursor: pointer; }
.davinci-range::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #ffd700; }

.corner-button-row { display: flex; gap: 4px; flex-wrap: wrap; }
.mini-tool-btn { height: 18px; padding: 0 4px; background: #2b2b2b; border: 1px solid #555; color: #888; cursor: pointer; border-radius: 2px; font-size: 9px; display: flex; align-items: center; gap: 2px; }
.mini-tool-btn.is-active { color: #ffd700; border-color: #ffd700; background: rgba(255, 215, 0, 0.05); }

.tracks-header-sticky { grid-column: 1 / 2; grid-row: 2 / 3; background: #3a3a3a; border-right: 1px solid #444; overflow: hidden; padding-top: 20px;}
.track-info { min-height: 110px; display: flex; align-items: center; padding-left: 8px; border-bottom: 1px solid #444; transition: background 0.2s; }
.track-info.is-active { background: #4a5a6a; }

.avatar-image { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #555; }
.avatar-placeholder { width: 44px; height: 44px; border-radius: 50%; background: #444; border: 2px dashed #666; }

.tracks-content-viewport { grid-column: 2 / 3; grid-row: 2 / 3; background: #18181c; overflow-y: auto; overflow-x: hidden; position: relative; }
.track-row { min-height: 50px; padding: 30px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
.track-lane { position: relative; height: 50px; background: rgba(255, 255, 255, 0.02); }

.time-ruler-track { position: relative; height: 36px; border-bottom: 1px solid #444; background: #222; }
.tick-line { position: absolute; bottom: 0; width: 1px; background: #444; pointer-events: none; }
.tick-line.major { height: 16px; background: #888; }
.tick-line.major-dim { height: 12px; background: #555; }
.tick-line.tenth { height: 8px; background: #555; }
.tick-line.frame { height: 4px; background: #444; }

.tick-label { 
  position: absolute; bottom: 18px; left: 3px; font-size: 10px; color: #aaa; 
  white-space: nowrap; font-family: 'Roboto Mono', monospace; 
}
.major .tick-label { color: #e0e0e0; font-weight: bold; }

.cursor-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: #ffd700; z-index: 50; pointer-events: none; }
.guide-time-label { position: absolute; top: 2px; left: 4px; background: #ffd700; color: #000; padding: 1px 4px; font-size: 10px; border-radius: 2px; font-weight: bold; }

.timeline-horizontal-scrollbar { position: absolute; bottom: 0; left: 0; width: 100%; height: 12px; overflow-x: auto; opacity: 0.6; z-index: 100; }
.selection-box-overlay { position: absolute; background: rgba(255, 215, 0, 0.15); border: 1px solid #ffd700; pointer-events: none; z-index: 100; }
</style>