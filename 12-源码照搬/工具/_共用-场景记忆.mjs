#!/usr/bin/env node
/**
 * 场景记忆 · 路径解析（公开模板版）
 *
 * 约定：
 *   <工作台>\引擎数据\.dsh\场景记忆\<场景>\场景私有记忆.md   ← 唯一真源
 *   <工作台>\引擎数据\.dsh\场景记忆\_共享记忆\              ← 共享层骨架
 *
 * 覆盖方式：环境变量 DSH_SCENE_MEMORY 优先。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WORKBENCH_ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')
export const SCENE_MEMORY_ROOT = process.env.DSH_SCENE_MEMORY || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh', '场景记忆')

export function sceneDirOf(nameOrPath) {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(SCENE_MEMORY_ROOT, nameOrPath)
}

/** 场景私有记忆的绝对路径（约定文件名：场景私有记忆.md） */
export function privateMemoryOf(scene) {
  const dir = sceneDirOf(scene)
  return path.join(dir, '场景私有记忆.md')
}

export function listSceneDirs() {
  if (!fs.existsSync(SCENE_MEMORY_ROOT)) return []
  return fs.readdirSync(SCENE_MEMORY_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()
}
