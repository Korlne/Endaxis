import { createRouter, createWebHistory } from 'vue-router'

const routes = [
    { path: '/', redirect: '/timeline' },
    // 终末地模式 (默认)
    { path: '/timeline', name: 'Timeline', component: () => import('../views/TimelineEntry.vue') },
    // 绝区零模式
    { path: '/zzz/editor', name: 'ZZZEditor', component: () => import('../views/ZZZEditor.vue') },
    { path: '/editor', name: 'DataEditor', component: () => import('../views/DataEditor.vue') }
]

const router = createRouter({
    history: createWebHistory('/'),
    routes
})

export default router