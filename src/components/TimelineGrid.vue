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
import { snapMs } from '@/utils/precision.js'

const store = useTimelineStore()
const { t, locale } = useI18n()

// ===================================================================================
// 初始化与常量
// ===================================================================================

const TIME_BLOCK_WIDTH = computed(() => store.timeBlockWidth)
provide('TIME_BLOCK_WIDTH', TIME_BLOCK_WIDTH)

// Refs
const tracksContentRef = ref(null)
const timeRulerWrapperRef = ref(null)
const tracksHeaderRef = ref(null)
const trackLaneRefs = ref([])

// Render State
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

const totalWidthComputed = computed(() => store.totalTimelineWidthPx)
const prepZoneWidthPxRounded = computed(() => Math.round(store.prepZoneWidthPx || 0))
const transformStyle = computed(() => ({ transform: `translateX(${-store.timelineShift}px)`, willChange: 'transform' }))

function getViewWindow({ bufferPx = 0 } = {}) {
  const totalPx = store.totalTimelineWidthPx;
  const totalSeconds = store.viewDuration;
  if (!tracksContentRef.value || store.isCapturing) {
    return { startPx: 0, endPx: totalPx, startTime: 0, endTime: totalSeconds }
  }
  const timelineWidth = store.timelineRect.width;
  const scrollLeft = store.timelineShift;
  const startPx = Math.max(scrollLeft - bufferPx, 0);
  const endPx = Math.min(scrollLeft + timelineWidth + bufferPx, totalPx);
  return { startPx, endPx, startTime: store.pxToTime(startPx), endTime: store.pxToTime(endPx) }
}

const rawDynamicTicks = computed(() => {
  const width = TIME_BLOCK_WIDTH.value;
  const viewWindow = getViewWindow({ bufferPx: 100 });
  const prep = store.prepDuration || 0
  const realStartVT = viewWindow.startTime;
  const realEndVT = viewWindow.endTime;
  const btStart = realStartVT - prep
  const btEnd = realEndVT - prep
  const gameStartVT = store.toGameTime ? store.toGameTime(realStartVT) : realStartVT;
  const gameStartBT = gameStartVT - prep

  let subDivision = 1;
  if (width >= 800) subDivision = 60;
  else if (width >= 200) subDivision = 10;
  else if (width >= 100) subDivision = 2;

  const minBtForTicks = (!store.prepExpanded && prep > 0) ? 0 : Math.min(btStart, gameStartBT)
  const startStep = Math.floor(minBtForTicks * subDivision);
  const endStep = Math.ceil(btEnd * subDivision);

  const realTicks = [];
  const gameTicks = [];

  for (let i = startStep; i <= endStep; i++) {
    const bt = i / subDivision;
    let type = '';
    let label = '';
    const isIntegerSecond = (i % subDivision === 0);

    if (isIntegerSecond) {
      const secondValue = Math.round(bt);
      const isFiveSec = secondValue % 5 === 0;
      const showAllLabels = width >= 100;
      if (showAllLabels || isFiveSec) {
        type = 'major';
        label = `${secondValue}s`;
      } else {
        type = 'major-dim';
      }
    } else {
      if (subDivision === 2) {
        type = 'tenth';
      } else if (subDivision === 10) {
        type = 'tenth';
        if (width >= 500) label = `.${Math.round((bt % 1) * 10)}`;
      } else if (subDivision === 60) {
        const frameIdx = i % 60;
        if (frameIdx % 10 === 0 && frameIdx !== 0) {
          type = 'tenth';
          if (width >= 600) label = `${frameIdx}f`;
        } else if (frameIdx % 2 === 0) {
          type = 'frame';
        } else {
          if (width < 1000) continue;
          type = 'frame';
        }
      } else {
        continue;
      }
    }

    const realVT = bt + prep
    if (!store.prepExpanded && prep > 0 && bt < -0.0001) {
      continue
    }
    const realX = store.timeToPx(realVT)
    realTicks.push({ time: bt, type, label, x: realX });

    const gameVT = bt + prep
    const mappedRealVT = store.toRealTime ? store.toRealTime(gameVT) : gameVT;
    if (mappedRealVT >= realStartVT && mappedRealVT <= realEndVT) {
      gameTicks.push({ time: bt, type, label, x: store.timeToPx(mappedRealVT) });
    }
  }
  return { realTicks, gameTicks };
});

const dynamicTicks = refThrottled(rawDynamicTicks, 100);

const formatGuideTime = (viewTime) => {
  const bt = viewTime - (store.prepDuration || 0)
  const abs = Math.abs(bt)
  const totalFrames = Math.floor(abs * 60 + 0.001) // 修复浮点精度造成的抖动
  const s = Math.floor(totalFrames / 60)
  const f = totalFrames % 60
  const sign = bt < -0.001 ? '-' : ''
  return `${sign}${s}s ${String(f).padStart(2, '0')}t`
}

// [新增] 绕过 Store 缺失导出的 Bug，在本地直接安全修改时间轴平移量
function setLocalTimelineShift(v) {
  const maxShift = Math.max(0, store.totalTimelineWidthPx - (store.timelineRect?.width || 0))
  store.timelineShift = Math.min(Math.max(0, v), maxShift)
}

const isPrepDurationEditorOpen = ref(false)
const prepDurationDraft = ref('')
const prepDurationInputRef = ref(null)

function openPrepDurationEditor() {
  prepDurationDraft.value = String(Number(store.prepDuration) || 0)
  isPrepDurationEditorOpen.value = true
  nextTick(() => prepDurationInputRef.value?.focus?.())
}
function closePrepDurationEditor() { isPrepDurationEditorOpen.value = false }
function applyPrepDurationDraft() {
  const v = Number(prepDurationDraft.value)
  if (!Number.isFinite(v)) return
  store.setPrepDuration(v)
  closePrepDurationEditor()
}

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
  ticking = true; setLocalTimelineShift(e.target.scrollLeft) // 已替换
  requestAnimationFrame(() => { ticking = false })
}

watch(() => store.timeBlockWidth, () => { nextTick(() => { forceSvgUpdate(); updateScrollbarHeight() }) })
watch(() => store.timelineShift, (val) => { if (fakeScrollbarRef.value) fakeScrollbarRef.value.scrollLeft = val })
watch(() => store.timelineScrollTop, (val) => {
  if (tracksHeaderRef.value) tracksHeaderRef.value.scrollTop = val
  if (tracksContentRef.value && Math.abs(tracksContentRef.value.scrollTop - val) > 1) tracksContentRef.value.scrollTop = val
})

function syncVerticalScroll() { if (tracksContentRef.value) store.setScrollTop(tracksContentRef.value.scrollTop) }

// ===================================================================================
// 交互与拖拽
// ===================================================================================

function onGridMouseMove(evt) { store.setCursorPosition(evt.clientX, evt.clientY); isCursorVisible.value = true }
function onGridMouseLeave() { isCursorVisible.value = false }

const isPanning = ref(false)
const panStartX = ref(0)
const panStartShift = ref(0)

function onPanMouseMove(evt) {
  if (!isPanning.value) return
  const deltaX = evt.clientX - panStartX.value
  setLocalTimelineShift(panStartShift.value - deltaX) // 已替换
}

function onPanMouseUp(evt) {
  if (isPanning.value) {
    isPanning.value = false
    window.removeEventListener('mousemove', onPanMouseMove)
    window.removeEventListener('mouseup', onPanMouseUp)
  }
}

function onContentMouseDown(evt) {
  if (evt.button === 2) { // 拦截右键，开始平移
    evt.preventDefault()
    isPanning.value = true
    panStartX.value = evt.clientX
    panStartShift.value = store.timelineShift
    window.addEventListener('mousemove', onPanMouseMove)
    window.addEventListener('mouseup', onPanMouseUp)
    return
  }

  if (store.isBoxSelectMode) {
    evt.stopPropagation(); evt.preventDefault(); isBoxSelecting.value = true
    boxStart.value = store.toTimelineSpace(evt.clientX, evt.clientY)
    boxRect.value = { left: boxStart.value.x, top: boxStart.value.y, width: 0, height: 0 }
    window.addEventListener('mousemove', onBoxMouseMove); window.addEventListener('mouseup', onBoxMouseUp); return
  }
  if (evt.target === tracksContentRef.value || evt.target.classList.contains('track-row')) store.selectTrack(null)
}

function onContextMenu(evt) {
  // 如果用户刚进行了右键平移拖拽，则屏蔽默认的右键菜单
  if (Math.abs(evt.clientX - panStartX.value) > 3) evt.preventDefault()
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
  setLocalTimelineShift(store.timeToPx(anchorTime) - offset) // 已替换
}

function handleWheel(e) { if (e.ctrlKey) { e.preventDefault(); adjustZoom(e.deltaY < 0 ? Math.round(store.timeBlockWidth * 0.15) : -Math.round(store.timeBlockWidth * 0.15), store.cursorCurrentTime) } }
function handleTrackWheel(e) {
  if (ticking) return
  if (e.ctrlKey) return handleWheel(e)
  if (Math.abs(e.deltaX) > 0 || e.shiftKey) { e.preventDefault(); setLocalTimelineShift(store.timelineShift + (e.shiftKey ? e.deltaY : e.deltaX)) } // 已替换
}

const alignGuide = ref({ visible: false, x: 0, top: 0, height: 0, label: '', type: '', color: '', iconKey: '', targetRect: null })

function updateAlignGuide(evt, action) {
  hoveredContext.value = { action, clientX: evt.clientX }
  if (!isAltDown.value || !store.selectedActionId || store.selectedActionId === action.instanceId) {
    alignGuide.value.visible = false
    return
  }
  const actionLayout = store.getNodeRect(action.instanceId)
  if (!actionLayout) return

  const rect = actionLayout.rect
  const relLeft = rect.left
  const relTop = rect.top
  const clickX = store.toTimelineSpace(evt.clientX, evt.clientY).x - rect.left
  const isClickLeft = clickX < (rect.width / 2)
  const isShift = isShiftDown.value

  let guideX = 0, label = '', type = '', color = '', iconKey = ''

  if (!isShift) {
    type = 'snap'
    color = '#00e5ff'
    if (isClickLeft) { guideX = relLeft; label = t('timelineGrid.alignGuide.snapFront'); iconKey = 'snap-left' }
    else { guideX = relLeft + rect.width; label = t('timelineGrid.alignGuide.snapBack'); iconKey = 'snap-right' }
  } else {
    type = 'align'
    color = '#ff00ff'
    if (isClickLeft) { guideX = relLeft; label = t('timelineGrid.alignGuide.alignLeft'); iconKey = 'align-left' }
    else { guideX = relLeft + rect.width; label = t('timelineGrid.alignGuide.alignRight'); iconKey = 'align-right' }
  }

  alignGuide.value = {
    visible: true, x: guideX, top: relTop, height: rect.height, label, iconKey, type, color,
    targetRect: { left: relLeft, top: relTop, width: rect.width, height: rect.height }
  }
}

function hideAlignGuide() { alignGuide.value.visible = false; hoveredContext.value = null }

function recalcAlignGuide() { if (hoveredContext.value) { const { action, clientX } = hoveredContext.value; updateAlignGuide({ clientX }, action) } }

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
    setLocalTimelineShift(store.timelineShift + autoScrollSpeed.value); // 已替换
    updateDragPosition(lastMouseX); autoScrollRaf = requestAnimationFrame(scroll)
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
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') { isAltDown.value = true; recalcAlignGuide(); } if (e.key === 'Shift') { isShiftDown.value = true; recalcAlignGuide(); } handleKeyDown(e) })
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { isAltDown.value = false; hideAlignGuide() } if (e.key === 'Shift') { isShiftDown.value = false; recalcAlignGuide(); } })
})
</script>

<template>
  <div class="timeline-grid-layout" :style="{ '--grid-row-height': gridRowHeight }">
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
        <div v-if="store.prepDuration > 0" class="prep-zone-bg prep-zone-bg--ruler" :style="{ width: `${prepZoneWidthPxRounded}px` }"></div>
        <div v-if="store.prepDuration > 0" class="battle-start-line battle-start-line--ruler" :style="{ left: `${prepZoneWidthPxRounded}px` }"></div>
        <div v-if="store.prepDuration > 0" class="prep-zone-controls" :style="{ left: `${prepZoneWidthPxRounded}px` }">
          <button type="button" class="prep-mini-btn" @click.stop="openPrepDurationEditor">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path></svg>
          </button>
        </div>
        <div v-if="isPrepDurationEditorOpen" class="prep-duration-popover" :style="{ left: `${prepZoneWidthPxRounded + 8}px` }" @mousedown.stop>
          <input ref="prepDurationInputRef" v-model="prepDurationDraft" class="prep-duration-input" type="number" min="0.5" step="0.1" @keydown.enter.prevent="applyPrepDurationDraft" @keydown.esc.prevent="closePrepDurationEditor" @blur="applyPrepDurationDraft" />
          <span class="prep-duration-unit">s</span>
        </div>
        <div v-show="showGameTime" class="time-ruler-track game-time" :style="{ width: `${totalWidthComputed}px` }">
          <div v-for="tick in dynamicTicks.gameTicks" :key="tick.time" class="tick-line" :class="tick.type" :style="{ left: `${Math.round(tick.x)}px` }">
            <span v-if="tick.label" class="tick-label">{{ tick.label }}</span>
          </div>
        </div>
        <div class="time-ruler-track" :style="{ width: `${totalWidthComputed}px` }">
          <div v-for="tick in dynamicTicks.realTicks" :key="tick.time" class="tick-line" :class="tick.type" :style="{ left: `${Math.round(tick.x)}px` }">
            <span v-if="tick.label" class="tick-label">{{ tick.label }}</span>
          </div>
        </div>
        <div class="operation-layer">
          <div v-for="op in operationMarkers" :key="op.id" class="key-cap" :class="[op.customClass, { 'is-hold': op.isHold }]" :style="{ left: `${op.left}px`, top: `${op.top}px`, width: op.width ? `${op.width}px` : 'auto', height: `${op.height}px`, fontSize: `${op.fontSize}px` }">
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

    <div class="tracks-content-viewport" ref="tracksContentRef" @mousedown="onContentMouseDown" @wheel="handleTrackWheel" @mousemove="onGridMouseMove" @mouseleave="onGridMouseLeave" @contextmenu="onContextMenu">
      <div class="tracks-content-scroller" :style="transformStyle">
        <div v-if="store.showCursorGuide && !store.isBoxSelectMode" class="cursor-guide" :style="{ transform: `translateX(${store.cursorPosTimeline.x}px)` }" v-show="isCursorVisible">
          <div class="guide-time-label">{{ formatGuideTime(store.pxToTime(store.cursorPosTimeline.x)) }}</div> </div>
        <div v-if="alignGuide.visible" class="align-guide-layer">
          <div class="target-highlight-box" :style="{ left: `${alignGuide.targetRect.left}px`, top: `${alignGuide.targetRect.top}px`, width: `${alignGuide.targetRect.width}px`, height: `${alignGuide.targetRect.height}px`, color: alignGuide.color }"></div>
          <div class="guide-line-vertical" :style="{ left: `${alignGuide.x}px`, color: alignGuide.color }"></div>
          <div class="guide-float-label" :style="{ left: `${alignGuide.x}px`, top: `${alignGuide.top - 28}px`, backgroundColor: alignGuide.color, '--arrow-color': alignGuide.color }">
            <span class="guide-icon">
              <svg v-if="alignGuide.iconKey === 'snap-left'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"></path><polyline points="12 19 5 12 12 5"></polyline><line x1="21" y1="4" x2="21" y2="20"></line></svg>
              <svg v-if="alignGuide.iconKey === 'snap-right'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><polyline points="12 5 19 12 12 19"></polyline><line x1="3" y1="4" x2="3" y2="20"></line></svg>
              <svg v-if="alignGuide.iconKey === 'align-left'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="18" x2="3" y2="18"></line><line x1="6" y1="2" x2="6" y2="22"></line></svg>
              <svg v-if="alignGuide.iconKey === 'align-right'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="18" x2="3" y2="18"></line><line x1="18" y1="2" x2="18" y2="22"></line></svg>
            </span>
            <span class="guide-text">{{ alignGuide.label }}</span>
          </div>
        </div>
        <div v-for="boundary in store.cycleBoundaries" :key="boundary.id" class="cycle-guide" :class="{ 'is-selected': boundary.id === store.selectedCycleBoundaryId }" :style="{ left: `${store.timeToPx(boundary.time)}px` }" @mousedown="onCycleLineMouseDown($event, boundary.id)"></div>
        <div v-if="isBoxSelecting" class="selection-box-overlay" :style="{ left: `${boxRect.left}px`, top: `${boxRect.top}px`, width: `${boxRect.width}px`, height: `${boxRect.height}px` }"></div>
        <div class="tracks-content">
          <div v-for="(track, index) in store.tracks" :key="index" class="track-row" :id="`track-row-${index}`" :style="{ '--track-height': `${TRACK_HEIGHT}px` }" @dragover.prevent @drop="onTrackDrop(track, $event)">
            <div class="track-lane" :style="getTrackLaneStyle" ref="trackLaneRefs" :data-track-index="index">
              <GaugeOverlay v-if="track.id" :track-id="track.id"/>
              <div class="actions-container">
                <ActionItem v-memo="[action]" v-for="action in track.actions" :key="action.instanceId" :action="action" @mousedown="onActionMouseDown($event, track, action)" @mousemove="updateAlignGuide($event, action)" @mouseleave="hideAlignGuide" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="timeline-horizontal-scrollbar" ref="fakeScrollbarRef" @scroll="onFakeScroll">
      <div class="scrollbar-spacer" :style="{ width: `${totalWidthComputed}px` }"></div>
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
.timeline-grid-layout { display: grid; grid-template-columns: 180px 1fr; grid-template-rows: var(--grid-row-height, 60px) 1fr 14px; width: 100%; height: 100%; overflow: hidden; user-select: none; }

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

.ruler-content-container { position: relative; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
.prep-zone-bg { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255, 255, 255, 0.04); border-right: 1px solid rgba(255, 255, 255, 0.12); pointer-events: none; z-index: 0; }
.battle-start-line { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, 0.38); transform: translateX(-1px); z-index: 2; }
.time-ruler-wrapper { grid-column: 2 / 3; grid-row: 1 / 2; background: #2b2b2b; border-bottom: 1px solid #444; overflow: hidden; z-index: 6; user-select: none; }
.time-ruler-track { position: relative; flex: 0 0 auto; height: 20px; width: 100%; border: none; background: transparent; }
.time-ruler-track.game-time { opacity: 0.5; }
.tick-line { position: absolute; bottom: 0; width: 1px; pointer-events: none; background: rgba(255, 255, 255, 0.3); transform: translateX(-0.5px); image-rendering: pixelated; }
.tick-line.major { height: 17px; background: rgba(255, 255, 255, 0.7); z-index: 2; }
.tick-line.major-dim { height: 17px; background: rgba(255, 255, 255, 0.15); z-index: 1; }
.tick-line.tenth { height: 10px; background: rgba(255, 255, 255, 0.4); z-index: 1; }
.tick-line.frame { height: 5px; background: rgba(255, 255, 255, 0.2); }
.tick-label { position: absolute; left: 3px; bottom: 1px; white-space: nowrap; font-family: 'Roboto Mono', monospace; font-size: 10px; color: #888; user-select: none; pointer-events: none; line-height: 1; }
.tick-line.major .tick-label { color: #e0e0e0; font-weight: bold; font-size: 11px; }

.cursor-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 215, 0, 0.8);
  pointer-events: none;
  z-index: 5;
  box-shadow: 0 0 6px #ffd700;
}

.guide-time-label {
  position: absolute;
  top: 4px;
  left: 2px;
  width: fit-content;
  background: rgba(0, 0, 0, 0.6);
  color: #ffd700;
  font-size: 10px;
  font-weight: bold;
  font-family: monospace;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
  line-height: 1;
  pointer-events: none;
}

.align-guide-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2000; overflow: visible; }
.target-highlight-box { position: absolute; border: 1px solid; border-radius: 4px; pointer-events: none; background: currentColor; opacity: 0.1; box-sizing: border-box; transition: all 0.15s cubic-bezier(0.25, 0.46, 0.45, 0.94); }
.target-highlight-box::after { content: ''; position: absolute; top: -2px; left: -2px; right: -2px; bottom: -2px; border: 1px solid inherit; border-radius: 5px; opacity: 0.6; animation: pulse-border 1.5s infinite; box-shadow: 0 0 8px currentColor; }
.guide-line-vertical { position: absolute; top: -100px; bottom: -100px; width: 1px; background: linear-gradient(to bottom, transparent, currentColor 20%, currentColor 80%, transparent); pointer-events: none; box-shadow: 0 0 6px currentColor; z-index: 2001; transition: left 0.15s cubic-bezier(0.2, 0.8, 0.2, 1); }
.guide-float-label { --arrow-color: transparent; position: absolute; padding: 4px 8px; border-radius: 20px; color: #000; font-weight: 800; font-size: 10px; white-space: nowrap; pointer-events: none; transform: translateX(-50%); backdrop-filter: blur(4px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); z-index: 2002; border: 1px solid rgba(255, 255, 255, 0.3); transition: left 0.15s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.15s ease-out; display: flex; align-items: center; gap: 4px; }
.guide-float-label::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -4px; border-width: 4px; border-style: solid; border-color: var(--arrow-color) transparent transparent transparent; }
.guide-icon { display: flex; align-items: center; }
.guide-text { line-height: 1; }

@keyframes pulse-border { 0% { opacity: 0.4; transform: scale(1); } 50% { opacity: 0.8; transform: scale(1.02); } 100% { opacity: 0.4; transform: scale(1); } }

.timeline-horizontal-scrollbar {
  grid-column: 2 / 3;
  grid-row: 3 / 4;
  width: 100%;
  height: 14px;
  overflow-x: auto;
  overflow-y: hidden;
  background: #18181c;
  border-top: 1px solid #444;
  z-index: 100;
}
.timeline-horizontal-scrollbar::-webkit-scrollbar { height: 12px; }
.timeline-horizontal-scrollbar::-webkit-scrollbar-thumb { background: #555; border-radius: 6px; }
.timeline-horizontal-scrollbar::-webkit-scrollbar-thumb:hover { background: #777; }
.scrollbar-spacer { height: 1px; }

.prep-zone-controls { position: absolute; left: 0; top: auto; bottom: 20px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 6px; pointer-events: none; z-index: 6; transform: translateX(-50%); }.prep-mini-btn { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; padding: 0; border: none; background: transparent; color: rgba(255, 255, 255, 0.85); cursor: pointer; border-radius: 6px; outline: none; transition: color 0.12s ease; pointer-events: auto; }.prep-mini-btn:hover { color: #ffd700; }.prep-duration-popover { position: absolute; top: 6px; display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: rgba(0, 0, 0, 0.85); border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5); z-index: 50; }.prep-duration-input { width: 72px; height: 22px; background: rgba(255, 255, 255, 0.06); color: #fff; border: 1px solid rgba(255, 255, 255, 0.18); outline: none; padding: 0 6px; font-family: 'Roboto Mono', monospace; font-size: 12px; }.prep-duration-input:focus { border-color: rgba(255, 215, 0, 0.7); }.prep-duration-unit { color: rgba(255, 255, 255, 0.6); font-size: 12px; font-family: 'Roboto Mono', monospace; }

.selection-box-overlay { position: absolute; background: rgba(255, 215, 0, 0.15); border: 1px solid #ffd700; pointer-events: none; z-index: 100; }
</style>