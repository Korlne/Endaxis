import { ElMessage } from 'element-plus'

export async function executeSave(actionTimelineData) {
    try {
        const payload = {
            metadata: {
                version: "1.0",
                base_fps: 60,
                max_ticks: 3600
            },
            action_timeline: actionTimelineData
        }

        const jsonData = JSON.stringify(payload, null, 2)
        const blob = new Blob([jsonData], { type: 'application/json' })
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = 'ZZZaxis_Timeline.json'
        link.click()
        URL.revokeObjectURL(link.href)

        ElMessage.success('ZZZaxis_Timeline.json 已生成')
    } catch (e) {
        console.error(e)
        ElMessage.error('导出失败')
    }
}