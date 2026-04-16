import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useZzzTimelineStore = defineStore('zzzTimeline', () => {
  // 独立的数据流，仅存储 ZZZ 模式节点
  const nodes = ref([])

  /**
   * 拓扑位移计算核心公式
   * @param {Object} sourceNode - 前置动作节点
   * @param {string} connectionType - 取消类型 ('combo'|'dodge'|'skill'|'swap')
   * @returns {number} 目标节点的 start_tick
   */
  const calculateTargetStartTick = (sourceNode, connectionType) => {
    if (!sourceNode || !sourceNode.cancel_windows) return 0
    
    // 获取对应取消窗的逻辑帧偏移，缺省为 0
    const offset = sourceNode.cancel_windows[connectionType] || 0
    
    return sourceNode.start_tick + offset
  }

  // 基础状态管理方法
  const addNode = (node) => {
    nodes.value.push(node)
  }

  const clearNodes = () => {
    nodes.value = []
  }

  return {
    nodes,
    calculateTargetStartTick,
    addNode,
    clearNodes
  }
})