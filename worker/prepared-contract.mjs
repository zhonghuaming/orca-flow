import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { invalid } from './flow-domain.mjs'

export const MAX_PREPARED = 32
export const MAX_STATE_BYTES = 224 * 1024
export function checkPreparedCapacity(state) {
  if (state.prepared.length > MAX_PREPARED || Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) throw invalid('准备记录已达到安全容量；未创建或覆盖任务说明，请保留已有记录。')
}
// A file left by a failed storage write is recoverable by the exact same request.
// Exclusive creation and exact comparison never overwrite another frozen contract.
export async function persistContract(dataDir, prepared) {
  await mkdir(dataDir, { recursive: true })
  try {
    const previous = await readFile(prepared.contractFile, 'utf8')
    if (previous !== prepared.contract) throw invalid('已有任务说明文件原文不同，拒绝覆盖；请人工核对原文件。')
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const files = await readdir(dataDir)
  if (files.filter((name) => /^prepared-.*\.md$/.test(name)).length >= MAX_PREPARED) throw invalid('任务说明文件已达到安全容量（含待恢复文件）；未写入新文件。')
  await writeFile(join(dataDir, `prepared-${prepared.id}.md`), prepared.contract, { encoding: 'utf8', flag: 'wx' })
}
