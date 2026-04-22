<script setup>
import { ref, computed, watch } from 'vue'
import { useTimelineStore } from '../stores/timelineStore.js'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowRight } from '@element-plus/icons-vue'
import { executeSave } from '@/api/saveStrategy.js'
import draggable from 'vuedraggable'

const store = useTimelineStore()
const { characterRoster, iconDatabase } = storeToRefs(store)

// === 常量定义 ===

const ELEMENTS = [
  { label: '物理', value: 'Physical' },
  { label: '火', value: 'Fire' },
  { label: '冰', value: 'Ice' },
  { label: '电', value: 'Electric' },
  { label: '以太', value: 'Ether' },
  { label: '玄墨', value: 'Auric Ink' },
  { label: '烈霜', value: 'Frost' },
  { label: '凛刃', value: 'Honed Edge' },
]

const CHARACTERISTICS = [
  { label: '强攻', value: 'Attack' },
  { label: '击破', value: 'Break' },
  { label: '异常', value: 'Anomaly' },
  { label: '支援', value: 'Support' },
  { label: '防护', value: 'Defense' },
  { label: '命破', value: 'Rupture' }
]

// === 状态与计算属性 ===

const searchQuery = ref('')
const selectedCharId = ref(null)
const activeTab = ref('basic')
const linkSegmentIndex = ref(0)

const filteredRoster = computed(() => {
  let list = characterRoster.value || []
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
  }
  return [...list].sort((a, b) => {
    const rankOrder = { 'S': 2, 'A': 1 }
    return (rankOrder[b.rank] || 0) - (rankOrder[a.rank] || 0)
  })
})

const selectedChar = computed(() => {
  return characterRoster.value.find(c => c.id === selectedCharId.value)
})

// === 核心方法 ===

function createDefaultSegment() {
  return {
    duration: 0,
    gaugeGain: 0,
    hit_ticks: [],
    cancel_windows: { combo: 0, dodge: 0, skill: 0, swap: 0 }
  }
}

function ensureDynamicSegments(char) {
  if (!char) return
  const types = ['basic_attack_segments', 'special_attack_segments']
  types.forEach(type => {
    if (!Array.isArray(char[type])) {
      char[type] = []
    }
    char[type].forEach(seg => {
      seg.duration = Number(seg.duration) || 0
      if (!seg.cancel_windows) {
        seg.cancel_windows = { combo: 0, dodge: 0, skill: 0, swap: 0 }
      }
    })
  })
}

function addSegment(tabType) {
  const field = `${tabType}_segments`
  if (!selectedChar.value[field]) selectedChar.value[field] = []
  selectedChar.value[field].push(createDefaultSegment())
}

function updateTicks(seg, value) {
  seg.hit_ticks = value.split(',')
    .map(v => Number(v.trim()))
    .filter(v => !isNaN(v))
}

function ensureLinkSegments(char, { force = false } = {}) {
  if (!char) return

  const sanitizeSeg = (seg) => {
    if (!seg || typeof seg !== 'object') return
    seg.duration = Number(seg.duration) || 0
    seg.cooldown = Number(seg.cooldown) || 0
    seg.gaugeGain = Number(seg.gaugeGain) || 0
    seg.followup_delay = Math.max(0, Math.round((Number(seg.followup_delay) || 0) * 1000) / 1000)
    if (!Array.isArray(seg.hit_ticks)) seg.hit_ticks = []
    if (!seg.cancel_windows || typeof seg.cancel_windows !== 'object') {
      seg.cancel_windows = { combo: 0, dodge: 0, skill: 0, swap: 0 }
    }
  }

  const seed = (suffix, cooldownOverride) => ({
    name: `${char.name || char.id || '连携'}${suffix}`,
    duration: 0,
    cooldown: cooldownOverride !== undefined ? cooldownOverride : 0,
    gaugeGain: 0,
    icon: '',
    followup_delay: 1,
    hit_ticks: [],
    cancel_windows: { combo: 0, dodge: 0, skill: 0, swap: 0 }
  })

  if (force || !Array.isArray(char.link_segments) || char.link_segments.length < 2) {
    char.link_segments = [seed('·一段', 0), seed('·二段')]
  } else {
    char.link_segments.forEach(sanitizeSeg)
  }
}

function selectChar(id) {
  selectedCharId.value = id
  activeTab.value = 'basic'
}

function updateCharId(event) {
  const newId = event.target.value
  if (!newId || !selectedChar.value) return
  selectedChar.value.id = newId
  selectedCharId.value = newId
}

function addNewCharacter() {
  const newId = `char_${Date.now()}`
  const newChar = {
    id: newId, 
    name: "新代理人", 
    rank: "A", 
    element: "Physical", 
    characteristic: "Attack", 
    avatar: "/avatars/default.webp",
    variants: [],
    basic_attack_segments: [],
    special_attack_segments: []
  }
  characterRoster.value.unshift(newChar)
  selectedCharId.value = newId
  ElMessage.success('已添加新代理人')
}

function deleteCurrentCharacter() {
  if (!selectedChar.value) return
  ElMessageBox.confirm(`确定要删除干员 "${selectedChar.value.name}" 吗？`, '警告', {
    confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning'
  }).then(() => {
    const idx = characterRoster.value.findIndex(c => c.id === selectedCharId.value)
    if (idx !== -1) {
      characterRoster.value.splice(idx, 1)
      selectedCharId.value = characterRoster.value.length > 0 ? characterRoster.value[0].id : null
      ElMessage.success('删除成功')
    }
  }).catch(() => {})
}

function addVariant() {
  if (!selectedChar.value) return
  if (!Array.isArray(selectedChar.value.variants)) selectedChar.value.variants = []
  selectedChar.value.variants.push({
    id: `var_${Date.now()}`,
    name: '自定义动作名称',
    type: 'variant',
    duration: 1,
    hit_ticks: [],
    cancel_windows: []
  })
}

// === 数据持久化 ===

function normalizeCharacterForSave(char) {
  if (char.dodge_duration === '' || char.dodge_duration === null) {
    delete char.dodge_duration
  } else if (char.dodge_duration !== undefined) {
    const dodgeVal = Number(char.dodge_duration)
    if (Number.isFinite(dodgeVal)) char.dodge_duration = Math.max(0, dodgeVal)
    else delete char.dodge_duration
  }

  const skillTypes = ['skill', 'link', 'ultimate', 'execution', 'dodge']
  skillTypes.forEach(type => {
    if (!Array.isArray(char[`${type}_hit_ticks`])) char[`${type}_hit_ticks`] = []
    char[`${type}_hit_ticks`] = char[`${type}_hit_ticks`].map(v => Number(v) || 0)
    if (!char[`${type}_cancel_windows`]) {
      char[`${type}_cancel_windows`] = { combo: 0, dodge: 0, skill: 0, swap: 0 }
    }
    delete char[`${type}_damage_ticks`]
    delete char[`${type}_anomalies`]
    delete char[`${type}_allowed_types`]
  })

  // 动态段数清洗
  ;['basic_attack_segments', 'special_attack_segments'].forEach(field => {
    if (Array.isArray(char[field])) {
      char[field].forEach(seg => {
        seg.duration = Number(seg.duration) || 0
        seg.hit_ticks = (seg.hit_ticks || []).map(v => Number(v) || 0)
        if (!seg.cancel_windows) seg.cancel_windows = { combo: 0, dodge: 0, skill: 0, swap: 0 }
      })
    }
  })

  // 连携清洗
  if (Array.isArray(char.link_segments)) {
    for (const seg of char.link_segments) {
      if (!seg || typeof seg !== 'object') continue
      seg.duration = Number(seg.duration) || 0
      seg.cooldown = Number(seg.cooldown) || 0
      seg.gaugeGain = Number(seg.gaugeGain) || 0
      seg.followup_delay = Math.max(0, Math.round((Number(seg.followup_delay) || 0) * 1000) / 1000)
      if (!Array.isArray(seg.hit_ticks)) seg.hit_ticks = []
      seg.hit_ticks = seg.hit_ticks.map(v => Number(v) || 0)
      if (!seg.cancel_windows) seg.cancel_windows = { combo: 0, dodge: 0, skill: 0, swap: 0 }
    }
  }

  // 清理过时字段
  delete char.attack_segments
  delete char.attack_duration
  delete char.attack_gaugeGain
  delete char.attack_allowed_types
  delete char.attack_anomalies
  delete char.attack_damage_ticks

  if (Array.isArray(char.variants)) {
    for (const v of char.variants) {
      v.duration = Number(v.duration) || 0
      if (!Array.isArray(v.hit_ticks)) v.hit_ticks = []
      v.hit_ticks = v.hit_ticks.map(n => Number(n) || 0)
      if (!Array.isArray(v.cancel_windows)) v.cancel_windows = []
      for (const cw of v.cancel_windows) {
        cw.time = Number(cw.time) || 0
      }
    }
  }
}

function saveData() {
  for (const char of characterRoster.value || []) {
    normalizeCharacterForSave(char)
  }
  const dataToSave = {
    ICON_DATABASE: iconDatabase.value,
    characterRoster: characterRoster.value
  }
  executeSave(dataToSave)
}

watch(selectedCharId, () => {
  if (!selectedChar.value) return
  ensureDynamicSegments(selectedChar.value)
  ensureLinkSegments(selectedChar.value)
  if (!Array.isArray(selectedChar.value.variants)) selectedChar.value.variants = []
}, { immediate: true })

</script>

<template>
  <div class="cms-layout">
    <aside class="cms-sidebar">
      <div class="sidebar-header">
        <h2>代理人数据</h2>
        <button class="ea-btn ea-btn--icon ea-btn--icon-28 ea-btn--icon-plus" @click="addNewCharacter">＋</button>
      </div>
      <div class="search-box">
        <input v-model="searchQuery" placeholder="搜索 ID 或名称..." />
      </div>

      <div class="char-list">
        <div v-for="char in filteredRoster" :key="char.id"
             class="char-item" :class="{ active: char.id === selectedCharId }"
             @click="selectChar(char.id)">
          <div class="avatar-wrapper-small" :class="`rarity-${char.rank === 'S' ? 6 : 4}-border`">
            <img :src="char.avatar" loading="lazy" decoding="async" @error="e=>e.target.src='/avatars/default.webp'" />
          </div>
          <div class="char-info">
            <span class="char-name">{{ char.name }}</span>
            <span class="char-meta" :class="`rarity-${char.rank === 'S' ? 6 : 4}`">
              {{ char.rank || 'A' }}级 {{ ELEMENTS.find(e=>e.value===char.element)?.label || char.element || '' }}
            </span>
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <button class="ea-btn ea-btn--block ea-btn--lg ea-btn--fill-success" @click="saveData">保存数据</button>
        <router-link to="/" class="ea-btn ea-btn--block ea-btn--outline-muted">↩ 返回排轴器</router-link>
      </div>
    </aside>

    <main class="cms-content">
      <div v-if="selectedChar" class="editor-panel">
        <header class="panel-header">
          <div class="header-left">
            <div class="avatar-wrapper-large" :class="`rarity-${selectedChar.rank === 'S' ? 6 : 4}-border`">
              <img :src="selectedChar.avatar" @error="e=>e.target.src='/avatars/default.webp'" />
            </div>
            <div class="header-titles">
              <h1 class="edit-title">{{ selectedChar.name }}</h1>
              <span class="id-tag">{{ selectedChar.id }}</span>
            </div>
          </div>
          <button class="ea-btn ea-btn--md ea-btn--fill-danger" @click="deleteCurrentCharacter">删除此干员</button>
        </header>

        <div class="cms-tabs">
          <button v-for="t in ['basic', 'basic_attack', 'special_attack', 'dodge', 'link', 'ultimate', 'variants']" 
                  :key="t" :class="{ active: activeTab === t }" @click="activeTab = t">
            {{ {basic:'基础', basic_attack:'普通攻击', special_attack:'特殊技', dodge:'闪避', link:'连携', ultimate:'终结技', variants:'变体'}[t] }}
          </button>
        </div>

        <div class="tab-content">
          <div v-show="activeTab === 'basic'" class="form-section">
            <h3 class="section-title">基本属性</h3>
            <div class="form-grid">
              <div class="form-group"><label>名称</label><input v-model="selectedChar.name" type="text" /></div>
              <div class="form-group"><label>ID (Unique)</label><input :value="selectedChar.id" @input="updateCharId" type="text" /></div>
              <div class="form-group">
                <label>级别</label>
                <el-select v-model="selectedChar.rank" size="large" style="width: 100%">
                  <el-option value="S" label="S 级" /><el-option value="A" label="A 级" />
                </el-select>
              </div>
              <div class="form-group">
                <label>元素属性</label>
                <el-select v-model="selectedChar.element" size="large" style="width: 100%">
                  <el-option v-for="elm in ELEMENTS" :key="elm.value" :label="elm.label" :value="elm.value" />
                </el-select>
              </div>
              <div class="form-group">
                <label>特性</label>
                <el-select v-model="selectedChar.characteristic" size="large" style="width: 100%">
                  <el-option v-for="wt in CHARACTERISTICS" :key="wt.value" :label="wt.label" :value="wt.value" />
                </el-select>
              </div>
              <div class="form-group full-width"><label>图标路径</label><input v-model="selectedChar.avatar" type="text" /></div>
            </div>
          </div>

          <div v-show="['basic_attack', 'special_attack'].includes(activeTab)">
            <div class="form-section">
              <div class="section-header">
                <h3 class="section-title">{{ activeTab === 'basic_attack' ? '普攻连段 (A1, A2...)' : '特殊技连段 (E1, E2...)' }}</h3>
                <button class="ea-btn ea-btn--sm ea-btn--fill-success" @click="addSegment(activeTab)">+ 添加段数</button>
              </div>
              
              <div v-for="(seg, idx) in selectedChar[`${activeTab}_segments`]" :key="idx" class="segment-card">
                <div class="segment-header">
                  <span>第 {{ idx + 1 }} 段 ({{ activeTab === 'basic_attack' ? 'A' : 'E' }}{{ idx + 1 }})</span>
                  <button class="ea-btn ea-btn--sm ea-btn--fill-danger" @click="selectedChar[`${activeTab}_segments`].splice(idx, 1)">删除</button>
                </div>
                <div class="form-grid">
                  <div class="form-group"><label>时长(s)</label><input type="number" step="0.01" v-model.number="seg.duration" /></div>
                  <div class="form-group full-width">
                    <label>Hit Ticks (逗号分隔)</label>
                    <input type="text" :value="(seg.hit_ticks || []).join(', ')" @change="e => updateTicks(seg, e.target.value)" />
                  </div>
                  <div class="form-grid four-col">
                    <div v-for="win in ['combo', 'dodge', 'skill', 'swap']" :key="win" class="form-group">
                      <label>{{ win }} Cancel</label>
                      <input type="number" v-model.number="seg.cancel_windows[win]" />
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="!selectedChar[`${activeTab}_segments`]?.length" class="empty-hint">暂无连段数据，请点击上方按钮添加。</div>
            </div>
          </div>

          <div v-show="['link', 'ultimate', 'dodge', 'skill'].includes(activeTab)">
            <div class="form-section">
              <h3 class="section-title">技能帧数据 ({{ activeTab }})</h3>
              
              <template v-if="activeTab === 'link' && Array.isArray(selectedChar.link_segments)">
                <div class="link-selector">
                  <button v-for="(_, i) in selectedChar.link_segments" :key="i" 
                          :class="{ active: linkSegmentIndex === i }" @click="linkSegmentIndex = i">
                    第 {{ i + 1 }} 段
                  </button>
                </div>
                <div class="form-group full-width">
                  <label>Hit Ticks (用逗号分隔)</label>
                  <input type="text" :value="(selectedChar.link_segments[linkSegmentIndex].hit_ticks || []).join(', ')" @change="e => updateTicks(selectedChar.link_segments[linkSegmentIndex], e.target.value)" />
                </div>
                <div class="form-grid four-col" v-if="selectedChar.link_segments[linkSegmentIndex].cancel_windows">
                  <div v-for="win in ['combo', 'dodge', 'skill', 'swap']" :key="win" class="form-group">
                    <label>{{ win }} Cancel</label>
                    <input type="number" v-model.number="selectedChar.link_segments[linkSegmentIndex].cancel_windows[win]" />
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="form-group full-width" style="margin-bottom: 15px;">
                  <label>Hit Ticks (用逗号分隔)</label>
                  <input type="text" :value="(selectedChar[`${activeTab}_hit_ticks`] || []).join(', ')" @change="e => { if (!selectedChar[`${activeTab}_hit_ticks`]) selectedChar[`${activeTab}_hit_ticks`] = []; updateTicks(selectedChar, e.target.value, `${activeTab}_hit_ticks`) }" />
                </div>
                <div class="form-grid four-col">
                  <div v-for="win in ['combo', 'dodge', 'skill', 'swap']" :key="win" class="form-group">
                    <label>{{ win }} Cancel</label>
                    <input type="number" :value="selectedChar[`${activeTab}_cancel_windows`]?.[win] || 0" 
                           @input="e => { if(!selectedChar[`${activeTab}_cancel_windows`]) selectedChar[`${activeTab}_cancel_windows`] = {combo:0, dodge:0, skill:0, swap:0}; selectedChar[`${activeTab}_cancel_windows`][win] = Number(e.target.value) }">
                  </div>
                </div>
              </template>
            </div>
          </div>

          <div v-show="activeTab === 'variants'">
            <div class="form-section">
              <div class="section-header">
                <h3 class="section-title">变体与自定义动作</h3>
                <button class="ea-btn ea-btn--sm ea-btn--fill-success" @click="addVariant">+ 添加变体</button>
              </div>
              <div v-for="(v, vIdx) in selectedChar.variants" :key="v.id" class="segment-card">
                <div class="form-grid four-col">
                  <div class="form-group"><label>自定义动作名称</label><input type="text" v-model="v.name"></div>
                  <div class="form-group"><label>持续时间 (秒)</label><input type="number" step="0.01" v-model.number="v.duration"></div>
                  <div class="form-group full-width"><label>Hit Ticks (用逗号分隔)</label>
                    <input type="text" :value="(v.hit_ticks || []).join(', ')" @change="e => updateTicks(v, e.target.value)">
                  </div>
                </div>
                <div style="margin-top: 15px;">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <label style="color: #aaa; font-size: 12px;">取消窗口 (Cancel Windows)</label>
                    <button class="ea-btn ea-btn--sm ea-btn--outline-muted" @click="v.cancel_windows.push({name: '新窗口', time: 0})">添加窗口</button>
                  </div>
                  <div v-for="(cw, cwIdx) in v.cancel_windows" :key="cwIdx" style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
                    <input type="text" v-model="cw.name" placeholder="窗口名称" class="mini-input" style="flex: 1;">
                    <input type="number" step="0.01" v-model.number="cw.time" placeholder="帧数" class="mini-input" style="width: 120px;">
                    <button class="ea-btn ea-btn--sm ea-btn--fill-danger" @click="v.cancel_windows.splice(cwIdx, 1)">删除</button>
                  </div>
                </div>
                <div style="text-align: right; margin-top: 10px;">
                  <button class="ea-btn ea-btn--sm ea-btn--fill-danger" @click="selectedChar.variants.splice(vIdx, 1)">删除此变体</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">请从左侧列表选择代理人</div>
    </main>
  </div>
</template>

<style scoped>
.cms-layout { display: flex; height: 100vh; background-color: #1e1e1e; color: #f0f0f0; overflow: hidden; }
.cms-sidebar { width: 300px; background-color: #252526; border-right: 1px solid #333; display: flex; flex-direction: column; }
.char-list { flex-grow: 1; overflow-y: auto; padding: 10px; }
.char-item { display: flex; align-items: center; padding: 8px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; }
.char-item.active { background-color: #37373d; }
.avatar-wrapper-small { width: 44px; height: 44px; border-radius: 6px; margin-right: 12px; border: 2px solid #444; overflow: hidden; }
.rarity-6-border { border-color: #FFD700; }
.rarity-4-border { border-color: #d8b4fe; }
.cms-content { flex-grow: 1; overflow-y: auto; padding: 30px; }

.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.section-title { border-left: 4px solid #4fc3f7; padding-left: 10px; font-size: 16px; margin: 0; }

.segment-card { border: 1px solid #333; padding: 15px; border-radius: 4px; margin-bottom: 15px; background: #1a1a1c; }
.segment-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #2a2a2e; color: #4fc3f7; font-weight: bold; }

.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
.full-width { grid-column: 1 / -1; }
.four-col { grid-template-columns: repeat(4, 1fr); }
.form-group { display: flex; flex-direction: column; }
.form-group label { margin-bottom: 6px; color: #aaa; font-size: 12px; }
.form-group input, .mini-input { background: #16161a; border: 1px solid #333; color: #fff; padding: 8px; border-radius: 4px; }

.cms-tabs { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid #333; overflow-x: auto; }
.cms-tabs button { padding: 10px 20px; background: none; border: none; color: #888; cursor: pointer; white-space: nowrap; }
.cms-tabs button.active { color: #fff; border-bottom: 2px solid #4fc3f7; }

.link-selector { display: flex; gap: 8px; margin-bottom: 15px; }
.link-selector button { background: #252526; border: 1px solid #444; color: #ccc; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.link-selector button.active { background: #4fc3f7; color: #000; border-color: #4fc3f7; }
.empty-hint { color: #666; font-size: 12px; text-align: center; padding: 20px; border: 1px dashed #333; }
</style>