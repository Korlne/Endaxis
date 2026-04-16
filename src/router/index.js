import { createRouter, createWebHistory } from 'vue-router'

const routes = [
    { path: '/', redirect: '/timeline' },
    { path: '/timeline', name: 'Timeline', component: () => import('../views/TimelineEntry.vue') },
    { path: '/editor', name: 'DataEditor', component: () => import('../views/DataEditor.vue') },

    // 注册 ZZZ 独立编辑器路由
    { 
      path: '/zzz/editor', 
      name: 'ZZZEditor', 
      component: () => import('../views/ZZZEditor.vue') 
    }
]

const router = createRouter({
    history: createWebHistory('/'),
    routes
})

export default router