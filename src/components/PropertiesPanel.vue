<script setup>
import { computed, ref, watch } from 'vue'
import { useTimelineStore } from '../stores/timelineStore.js'
import draggable from 'vuedraggable'
import CustomNumberInput from './CustomNumberInput.vue'
import { ArrowRight } from '@element-plus/icons-vue'
import { getRectPos } from '@/utils/layoutUtils.js'
import { buildEffectBindingOptions } from '@/utils/effectBindingOptions.js'
import { useI18n } from 'vue-i18n'

const store = useTimelineStore()
const { t } = useI18n({ useScope: 'global' })

// ===================================================================================
// 1. 常量与配置
// ===================================================================================
const HIGHLIGHT_COLORS = {
  default: '#ffd700',
  red: '#ff7875',
  blue: '#00e5ff',
}

function getEffectDisplayName(type) {
  if (!type) return t('common.unknown')
  const key = `effects.name.${type}`
  const out = t(key)
  return out === key ? type : out
}

const GROUP_DEFINITIONS = computed(() => [
  { label: t('effects.group.physical'), keys: ['break', 'armor_break', 'stagger', 'knockdown', 'knockup', 'ice_shatter'] },
  { label: t('effects.group.attach'), matcher: (key) => key.endsWith('_attach') },
  { label: t('effects.group.burst'), matcher: (key) => key.endsWith('_burst') },
  { label: t('effects.group.status'), keys: ['burning', 'conductive', 'frozen', 'corrosion'] },
  { label: t('effects.group.other'), keys: ['default'] }
])

function getFullTypeName(type) {
  const key = `skillType.${type}`
  const out = t(key)
  return out === key ? t('skillType.unknown') : out
}

// ===================================================================================
// 2. 核心状态计算
// ===================================================================================

const isTicksExpanded = ref(false)
const isBarsExpanded = ref(false)
const localSelectedAnomalyId = ref(null) 

const selectedWeaponStatus = computed(() => {
  if (!store.selectedWeaponStatusId) return null
  return (store.weaponStatuses || []).find(s => s.id === store.selectedWeaponStatusId) || null
})

const isWeaponStatusMode = computed(() => !!selectedWeaponStatus.value)
const isSetLibraryMode = computed(() => store.selectedLibrarySource === 'set')

const activeLibraryList = computed(() => {
  if (store.selectedLibrarySource === 'weapon') return store.activeWeaponSkillLibrary || []
  if (store.selectedLibrarySource === 'set') return store.activeSetBonusLibrary || []
  return store.activeSkillLibrary || []
})

const isWeaponLibraryMode = computed(() => store.selectedLibrarySource === 'weapon')

watch(() => store.selectedLibrarySkillId, () => {
  localSelectedAnomalyId.value = null
})

const targetData = computed(() => {
  if (store.selectedActionId) {
    for (const track of (store.tracks || [])) {
      const found = (track.actions || []).find(a => a.instanceId === store.selectedActionId)
      if (found) return found
    }
  }
  if (store.selectedLibrarySkillId) {
    return (activeLibraryList.value || []).find(s => s.id === store.selectedLibrarySkillId)
  }
  if (selectedWeaponStatus.value) {
    return selectedWeaponStatus.value
  }
  return null
})

const isLibraryMode = computed(() => {
  return !!store.selectedLibrarySkillId && !store.selectedActionId && !isWeaponStatusMode.value
})

const currentCharacter = computed(() => {
  if (!targetData.value) return null
  if (!isLibraryMode.value) {
    const track = (store.tracks || []).find(t => (t.actions || []).some(a => a.instanceId === store.selectedActionId))
    if (!track) return null
    return (store.characterRoster || []).find(c => c.id === track.id)
  }
  if (store.activeTrackId) {
    return (store.characterRoster || []).find(c => c.id === store.activeTrackId)
  }
  return null
})

const currentSkillType = computed(() => {
  if (isWeaponStatusMode.value) return 'weapon'
  return targetData.value?.type || 'unknown'
})

// === 分段连携相关计算 ===
const isComboInstance = computed(() => {
  if (isLibraryMode.value) return false
  const a = targetData.value
  if (!a) return false
  const idx = Number(a.comboSegmentIndex) || 0
  const total = Number(a.comboSegmentTotal) || 0
  return !!a.comboGroupId && idx > 0 && total >= 2 && idx <= total
})

const comboLinked = computed(() => {
  if (!isComboInstance.value) return false
  return targetData.value.comboLinked !== false
})

const isComboHasNext = computed(() => {
  if (!isComboInstance.value) return false
  const idx = Number(targetData.value.comboSegmentIndex) || 0
  const total = Number(targetData.value.comboSegmentTotal) || 0
  return idx > 0 && total > 0 && idx < total
})

const comboSegmentText = computed(() => {
  if (!isComboInstance.value) return ''
  const idx = Number(targetData.value.comboSegmentIndex) || 0
  const total = Number(targetData.value.comboSegmentTotal) || 2
  return `${idx}/${total}`
})

function toggleComboLinked() {
  if (!isComboInstance.value) return
  updateActionProp('comboLinked', !comboLinked.value)
}

// === 统一更新函数 ===
function commitUpdate(payload) {
  if (!targetData.value) return
  if (isWeaponStatusMode.value) {
    store.updateWeaponStatus(store.selectedWeaponStatusId, payload)
    return
  }
  if (isLibraryMode.value) {
    if (isSetLibraryMode.value) {
      const category = targetData.value.setCategory
      if (!category) return
      if (payload.duration !== undefined) {
        store.updateEquipmentCategoryOverride(category, {
          setBonus: { duration: payload.duration }
        })
      }
      return
    }
    store.updateLibrarySkill(targetData.value.id, payload)
  } else {
    store.updateAction(store.selectedActionId, payload)
  }
}

// === 异常状态与 Ticks 相关 ===
const anomalyRows = computed({
  get: () => targetData.value?.physicalAnomaly || [],
  set: (val) => commitUpdate({ physicalAnomaly: val })
})

const activeAnomalyId = computed(() => {
  return isLibraryMode.value ? localSelectedAnomalyId.value : store.selectedAnomalyId
})

const currentSelectedCoords = computed(() => {
  if (!activeAnomalyId.value || !targetData.value) return null
  const rows = targetData.value.physicalAnomaly || []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    const c = row.findIndex(e => e._id === activeAnomalyId.value)
    if (c !== -1) return { rowIndex: r, colIndex: c }
  }
  return null
})

function updateActionProp(key, value) {
  commitUpdate({ [key]: value })
}

// ===================================================================================
// 3. 资源查询 (防御性重构)
// ===================================================================================

const iconOptions = computed(() => {
  const allGlobalKeys = Object.keys(store.iconDatabase || {})
  const allowed = targetData.value?.allowedTypes
  const availableKeys = allGlobalKeys.filter(key =>
      (allowed && allowed.includes(key)) || key === 'default'
  )

  const groups = []
  if (currentCharacter.value?.exclusive_buffs) {
    let exclusiveOpts = currentCharacter.value.exclusive_buffs.map(buff => ({
      label: `★ ${buff.name}`, value: buff.key, path: buff.path
    }))
    if (allowed && allowed.length > 0) exclusiveOpts = exclusiveOpts.filter(opt => allowed.includes(opt.value))
    if (exclusiveOpts.length > 0) groups.push({ label: t('effects.group.exclusive'), options: exclusiveOpts })
  }

  const processedKeys = new Set()
  GROUP_DEFINITIONS.value.forEach(def => {
    const groupKeys = availableKeys.filter(key => {
      if (processedKeys.has(key)) return false
      if (def.keys && def.keys.includes(key)) return true
      if (def.matcher && def.matcher(key)) return true
      return false
    })
    if (groupKeys.length > 0) {
      groupKeys.forEach(k => processedKeys.add(k))
      groups.push({
        label: def.label,
        options: groupKeys.map(key => ({
          label: getEffectDisplayName(key), value: key, path: store.iconDatabase[key]
        }))
      })
    }
  })
  return groups
})

function getIconPath(type, charId = null) {
  const db = store.iconDatabase || {}
  if (db[type]) return db[type]
  const targetChar = charId
      ? (store.characterRoster || []).find(c => c.id === charId)
      : currentCharacter.value
  if (targetChar?.exclusive_buffs) {
    const exclusive = targetChar.exclusive_buffs.find(b => b.key === type)
    if (exclusive) return exclusive.path
  }
  return db['default'] || ''
}
</script>

<template>
  <div class="properties-panel">
    <div class="panel-header">
      <div class="header-main-row">
        <div class="left-group">
          <div class="header-icon-bar"></div>
          <h3 class="char-name">
            {{ targetData ? targetData.name : t('propertiesPanel.noSelection') }}
          </h3>
          <span v-if="targetData && isLibraryMode" class="mode-badge">{{ t('propertiesPanel.globalMode') }}</span>
        </div>
        <div class="right-group">
          <div v-if="targetData" class="skill-type-minimal">
            {{ getFullTypeName(currentSkillType) }}
          </div>
        </div>
      </div>
      <div class="header-divider"></div>
    </div>

    <div v-if="targetData" class="scrollable-content">
      <div class="section-container tech-style">
        <div class="panel-tag-mini">{{ t('propertiesPanel.sections.basic') }}</div>
        <div class="attribute-grid">
          <div class="form-group compact">
            <label>时长 (Tick)</label>
            <CustomNumberInput :model-value="Math.round((targetData.duration || 0) * 60)" @update:model-value="val => updateActionProp('duration', val / 60)" :step="1" :min="0" :activeColor="HIGHLIGHT_COLORS.default" text-align="center"/>
          </div>

          <div class="form-group compact" v-if="isComboInstance">
            <label>{{ t('propertiesPanel.labels.comboSegment') }}</label>
            <div class="combo-hint">{{ comboSegmentText }}</div>
          </div>

          <div class="form-group compact" v-if="isComboInstance">
            <label>{{ t('propertiesPanel.labels.comboLink') }}</label>
            <button
              type="button"
              class="ea-btn ea-btn--sm ea-btn--glass-rect ea-btn--accent-gold ea-btn--glass-rect-accent"
              @click.stop="toggleComboLinked"
            >
              {{ comboLinked ? t('propertiesPanel.combo.unlink') : t('propertiesPanel.combo.relink') }}
            </button>
          </div>

          <div class="form-group compact" v-if="currentSkillType === 'skill'">
            <label>{{ t('propertiesPanel.labels.spCost') }}</label>
            <CustomNumberInput :model-value="targetData.spCost" @update:model-value="val => updateActionProp('spCost', val)" :min="0" :border-color="HIGHLIGHT_COLORS.default" text-align="center"/>
          </div>

        </div>
      </div>

      <div class="section-container tech-style border-red">
        <div class="panel-tag-mini red">判定点与取消窗 (Ticks & Cancels)</div>
        <div class="attribute-grid">
          <div class="form-group compact full-width-col" style="grid-column: span 2;">
            <label>Hit Ticks (以逗号分隔)</label>
            <input type="text" class="simple-input" :value="(targetData.hit_ticks || []).join(', ')" @change="e => {
              const arr = e.target.value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
              updateActionProp('hit_ticks', arr);
            }" placeholder="例如: 13, 24" />
          </div>
          <div class="form-group compact">
            <label>Combo 取消窗</label>
            <CustomNumberInput :model-value="targetData.cancelWindows?.combo || 0" @update:model-value="val => updateActionProp('cancelWindows', { ...(targetData.cancelWindows || {}), combo: val })" :min="0" border-color="#ff7875" text-align="center"/>
          </div>
          <div class="form-group compact">
            <label>Swap 取消窗</label>
            <CustomNumberInput :model-value="targetData.cancelWindows?.swap || 0" @update:model-value="val => updateActionProp('cancelWindows', { ...(targetData.cancelWindows || {}), swap: val })" :min="0" border-color="#ff7875" text-align="center"/>
          </div>
          <div class="form-group compact">
            <label>Dodge 取消窗</label>
            <CustomNumberInput :model-value="targetData.cancelWindows?.dodge || 0" @update:model-value="val => updateActionProp('cancelWindows', { ...(targetData.cancelWindows || {}), dodge: val })" :min="0" border-color="#ff7875" text-align="center"/>
          </div>
          <div class="form-group compact">
            <label>Skill 取消窗</label>
            <CustomNumberInput :model-value="targetData.cancelWindows?.skill || 0" @update:model-value="val => updateActionProp('cancelWindows', { ...(targetData.cancelWindows || {}), skill: val })" :min="0" border-color="#ff7875" text-align="center"/>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 样式保持不变，已支持新逻辑渲染 */
.properties-panel { padding: 15px; background-color: #252525; display: flex; flex-direction: column; gap: 15px; height: 100%; box-sizing: border-box; overflow-y: auto; font-size: 13px; color: #e0e0e0; transition: background-color 0.3s ease; scrollbar-width: none; -ms-overflow-style: none; }
.properties-panel::-webkit-scrollbar { display: none; }
.panel-header { display: flex; flex-direction: column; gap: 4px; margin-bottom: 0; }
.header-main-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; overflow: hidden; }
.left-group { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.header-icon-bar { width: 4px; height: 18px; background-color: #ffd700; }
.char-name { margin: 0; color: #fff; font-size: 18px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mode-badge { font-size: 10px; color: #888; background: #333; padding: 1px 4px; border-radius: 2px; }
.skill-type-minimal { font-size: 11px; color: #666; background: rgba(255, 255, 255, 0.05); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1); letter-spacing: 1px; }
.header-divider { height: 2px; background: linear-gradient(90deg, #ffd700 0%, transparent 100%); opacity: 0.3; margin-top: 3px; }
.section-container.tech-style { background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); border-left: 3px solid rgba(255, 255, 255, 0.2); padding: 12px; position: relative; margin-top: 12px !important; }
.attribute-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px; }
.combo-hint { height: 28px; display: flex; align-items: center; justify-content: center; background-color: #16161a; box-shadow: 0 0 0 1px #333 inset; color: rgba(255, 255, 255, 0.7); font-family: 'Roboto Mono', 'Consolas', monospace; font-size: 12px; }
.simple-input { background: transparent; border: none; border-bottom: 1px solid #555; color: #ccc; width: 100%; font-size: 12px; padding: 0 0 2px 0; }
</style>