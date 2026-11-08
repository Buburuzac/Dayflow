import { contextBridge, ipcRenderer } from 'electron'
import type { AppStatus, DayflowApi } from '../shared/types.ts'

const api: DayflowApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s, secrets) => ipcRenderer.invoke('settings:save', s, secrets),
  testProvider: () => ipcRenderer.invoke('provider:test'),
  getCards: (day) => ipcRenderer.invoke('cards:get', day),
  getCardScreenshots: (id) => ipcRenderer.invoke('cards:screenshots', id),
  getBatches: (day) => ipcRenderer.invoke('batches:get', day),
  getStatus: () => ipcRenderer.invoke('status:get'),
  pause: (minutes) => ipcRenderer.invoke('recorder:pause', minutes),
  resume: () => ipcRenderer.invoke('recorder:resume'),
  analyzeNow: () => ipcRenderer.invoke('analysis:now'),
  reprocessDay: (day) => ipcRenderer.invoke('analysis:reprocessDay', day),
  deleteCard: (id) => ipcRenderer.invoke('cards:delete', id),
  updateCardTitle: (id, title) => ipcRenderer.invoke('cards:title', id, title),
  updateCardCategory: (id, category) => ipcRenderer.invoke('cards:category', id, category),
  exportMarkdown: (from, to) => ipcRenderer.invoke('export:markdown', from, to),
  openDataFolder: () => ipcRenderer.invoke('app:openData'),
  call: (channel, ...args) => {
    if (!/^(weekly|daily|chat|flow|timelapse|review|goals|sync|projects):/.test(channel)) {
      return Promise.reject(new Error(`Channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, cb) => {
    const h = (_e: unknown, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  imageUrl: (filePath) => `dayflow-img://shot/?p=${encodeURIComponent(filePath)}`,
  onStatus: (cb) => {
    const h = (_e: unknown, s: AppStatus) => cb(s)
    ipcRenderer.on('status', h)
    return () => ipcRenderer.removeListener('status', h)
  },
  onCardsChanged: (cb) => {
    const h = () => cb()
    ipcRenderer.on('cards-changed', h)
    return () => ipcRenderer.removeListener('cards-changed', h)
  },
}

contextBridge.exposeInMainWorld('dayflow', api)
