export async function executeFetch() {
    const response = await fetch('/ZZZaxis_Timeline.json')

    if (!response.ok) {
        throw new Error(`Local load failed: ${response.statusText}`)
    }

    const rawData = await response.json()
    return rawData.action_timeline || []
}