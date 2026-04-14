/**
 * 导出 ZZZ 极简排轴数据
 * 仅提取时序相关字段，剔除所有战斗公式、属性(stats)、失衡(stagger)等相关字段
 * @param {Object} timelineData - 内存中的全局 timeline 数据
 * @returns {Object} 极简结构的 JSON 对象
 */
export function exportZZZData(timelineData) {
  if (!timelineData || !Array.isArray(timelineData.actions)) {
    return { version: "1.0.0", baseFps: 60, actions: [] };
  }

  const cleanActions = timelineData.actions.map(action => {
    return {
      id: action.id,
      name: action.name,
      characterName: action.characterName || 'Unknown',
      duration: action.duration,
      hitTicks: Array.isArray(action.hitTicks) ? [...action.hitTicks] : [],
      startTime: action.startTime
    };
  });

  return {
    version: "1.0.0",
    baseFps: 60,
    actions: cleanActions
  };
}

/**
 * 导入并适配 JSON 数据为 ZZZ 单轨格式
 * 支持自动过滤旧版 Endaxis 的多轨道(tracks)和失衡(stagger)数据
 * @param {Object} rawData - 用户导入的原始 JSON 数据
 * @returns {Object} 符合 ZZZ 单轨序列标准的 timeline 数据
 */
export function importZZZData(rawData) {
  const result = {
    version: "1.0.0",
    baseFps: 60,
    actions: []
  };

  if (!rawData) return result;

  // 1. 若为已符合 ZZZ 标准的数据格式
  if (rawData.actions && Array.isArray(rawData.actions)) {
    result.actions = rawData.actions.map(a => ({
      id: a.id || crypto.randomUUID(),
      name: a.name || 'Unnamed Action',
      characterName: a.characterName || 'Unknown',
      duration: typeof a.duration === 'number' ? a.duration : 60,
      hitTicks: Array.isArray(a.hitTicks) ? a.hitTicks : [],
      startTime: typeof a.startTime === 'number' ? a.startTime : 0
    }));
    return result;
  }

  // 2. 若为旧版 Endaxis 格式，包含 tracks 多行轨道，将其拍扁合并到单轴
  if (rawData.tracks && Array.isArray(rawData.tracks)) {
    let mergedActions = [];
    
    rawData.tracks.forEach(track => {
      if (track.actions && Array.isArray(track.actions)) {
        const mappedActions = track.actions.map(a => ({
          id: a.id || crypto.randomUUID(),
          name: a.name || 'Legacy Action',
          characterName: track.characterName || track.name || 'Unknown',
          duration: typeof a.duration === 'number' ? a.duration : 60,
          // 尝试从旧版的伤害事件(damageEvents)中提取判定点
          hitTicks: a.hitTicks ? a.hitTicks : (a.damageEvents ? a.damageEvents.map(e => e.delay || 0) : []),
          startTime: typeof a.startTime === 'number' ? a.startTime : 0
        }));
        mergedActions = mergedActions.concat(mappedActions);
      }
    });
    
    // 强制根据时间轴起始时间进行线性排序
    mergedActions.sort((a, b) => a.startTime - b.startTime);
    result.actions = mergedActions;
  }

  return result;
}