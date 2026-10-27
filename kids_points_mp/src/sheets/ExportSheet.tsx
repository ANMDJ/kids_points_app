import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { SmallPill } from '../components/Pills'
import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { FamilyExport, FamilyExportSection } from '../data/types'
import {
  exportFileName,
  exportGeneratedText,
  exportIsKnownSchemaVersion,
  exportRowCount,
  exportSchemaVersion,
  exportSectionCountText,
  exportSections,
  exportTruncatedSectionsText,
  memberRoleLabelOf
} from '../data/types'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface ExportSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 家庭数据导出（W7-C）：家长把孩子的全部数据带走。
 *
 * ── 这个面板要回答的两个问题 ────────────────────────────────────────────────
 *   ① **文件里有什么**：各段的条数（`summary.counts`）与总行数；
 *   ② **文件是不是完整的**：`summary.truncated` 为 true 时，把「哪几段被
 *      截断」写在最显眼的位置 —— 一份不完整的备份如果看起来完整，
 *      比没有备份更糟（家长会以为数据取全了，然后把原始数据删掉）。
 *
 * ── 为什么先拉成员、再拉导出 ────────────────────────────────────────────────
 *   `export_family_data` 在矩阵里只有 guardian ALLOW，而客户端判断
 *   「我是不是家长」只能靠 `GET /members` 里 `isSelf` 那一行。直接拉导出：
 *   孩子必然吃一个 403 —— 用一次注定失败的请求探测角色，既慢又会把
 *   「没有权限」画成「加载失败」。所以先 `refreshMembers()`。
 *
 * ── 为什么这里不提「同意必须先作出」 ────────────────────────────────────────
 *   导出是**读**，且在 `consent-policy` 的豁免集合里：撤回同意后
 *   `ConsentGuard` 会拦写动作，但导出必须继续可用（04 §5 可携带权）。
 *   面板把这句写出来，家长才不会以为「撤回 = 数据被扣住」。
 */
export default function ExportSheet({ visible, onClose }: ExportSheetProps) {
  const store = useStore()
  /** 有读请求（成员 / 导出文件）在途；导出自身的单飞由 `store.isExportBusy` 表达。 */
  const [busy, setBusy] = useState(false)

  const canExport = store.canExportFamilyData
  const file = store.familyExport
  const exportError = store.exportError
  const memberError = store.memberError

  useEffect(() => {
    if (!visible) return
    // 打开弹窗才拉（低频页面不该让每次首页刷新都多付一次往返）。
    // 失败**不弹窗**：错误留在 store 里，由下面照实展示。
    setBusy(true)
    const run = async () => {
      if (store.isLiveMode && store.selfMember === null) {
        await store.refreshMembers()
      }
      // 角色不确定（成员没拉到）时不发注定 403 的请求。
      if (store.canExportFamilyData) {
        await store.loadExport()
      }
    }
    void run().finally(() => setBusy(false))
  }, [visible, store])

  /** 角色没拉到时重来一遍（成员 → 导出）。 */
  const handleRetryBootstrap = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshMembers()
      if (store.canExportFamilyData) await store.loadExport()
    } finally {
      setBusy(false)
    }
  }

  const handleReload = async () => {
    if (busy || store.isExportBusy) return
    setBusy(true)
    try {
      await store.loadExport()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 复制**服务端原文**（不是本地模型的再序列化）：家长拿到的应当与服务端
   * 下发的文本一致。剪贴板里放的是完整文件，不只是摘要。
   */
  const handleCopy = (item: FamilyExport) => {
    if (item.rawJson.trim() === '') {
      // 传输层没给出原文（理论上只会在坏响应上发生）：宁可说「复制不了」，
      // 也不要复制一个空字符串，让家长以为文件是空的。
      toast('这份文件的内容无法读取，请点「重新生成」再试。')
      return
    }
    void Taro.setClipboardData({ data: item.rawJson }).then(() =>
      toast(
        `已复制导出文件（${sizeText(utf8ByteLength(item.rawJson))}，共 ${exportRowCount(item)} 条）`
      )
    )
  }

  const hint = (text: string) => (
    <View className='kp-export__hint'>
      <Text className='kp-export__hint-text'>{text}</Text>
    </View>
  )

  /** 段清单：每段一行「本文件条数 / 库里全量条数」。 */
  const sectionCard = (item: FamilyExport) => (
    <AppCard radius={16}>
      <View className='kp-export__title-row'>
        <Text className='kp-export__card-title'>文件内容</Text>
        <Text className='kp-export__total'>{`共 ${exportRowCount(item)} 条`}</Text>
      </View>
      <View className='kp-sheet-gap-xs' />
      {exportSections(item).map((section: FamilyExportSection) => (
        <View className='kp-export__section-row' key={section.key}>
          <Text className='kp-export__section-label'>{section.label}</Text>
          <Text
            className={`kp-export__section-count ${
              section.truncated ? 'is-truncated' : ''
            }`}
          >
            {exportSectionCountText(section)}
          </Text>
        </View>
      ))}
    </AppCard>
  )

  const actions = (item: FamilyExport) => {
    const disabled = busy || store.isExportBusy
    return (
      <View className='kp-export__actions'>
        <SmallPill
          label='复制 JSON'
          filled
          padding={[18, 10]}
          onClick={disabled ? undefined : () => handleCopy(item)}
        />
        <View className='kp-export__action-gap' />
        <SmallPill
          label='重新生成'
          padding={[18, 10]}
          onClick={disabled ? undefined : () => void handleReload()}
        />
      </View>
    )
  }

  const errorCard = (error: typeof exportError) => (
    <AppCard radius={16}>
      <Text className='kp-export__card-title'>生成导出文件失败</Text>
      <View className='kp-sheet-gap-xs' />
      <Text className='kp-export__paragraph'>
        {error?.userMessage ?? '导出请求失败，原因未知。请重试。'}
      </Text>
      <View className='kp-export__actions'>
        <SmallPill
          label='重试'
          onClick={busy ? undefined : () => void handleReload()}
        />
      </View>
    </AppCard>
  )

  /** 角色未知时的说明 + 重试（与同意面板同口径）。 */
  const unknownRoleRows = () => {
    const loading = busy || store.memberStatus === 'loading'
    return (
      <View>
        {loading ? (
          <View className='kp-invite__status'>
            <Text className='kp-invite__status-text'>正在确认你的身份…</Text>
          </View>
        ) : (
          <View className='kp-invite__status-row'>
            <Text className='kp-invite__error-text'>
              {`无法确认你的身份（${
                memberError?.userMessage ?? '成员列表还没拉到'
              }），暂时不能判断能不能导出。`}
            </Text>
            <View
              className='kp-invite__chip'
              onClick={() => void handleRetryBootstrap()}
            >
              <Text className='kp-invite__chip-text'>重试</Text>
            </View>
          </View>
        )}
      </View>
    )
  }

  /** 文件头：孩子 + 生成时间 + 完整性 + 格式版本。 */
  const fileCard = (item: FamilyExport) => {
    const complete = !item.truncated
    return (
      <AppCard radius={16}>
        <View className='kp-export__title-row'>
          <Text className='kp-export__card-title'>{`${item.childName} 的数据`}</Text>
          <SmallPill label={complete ? '完整' : '不完整'} filled={complete} />
        </View>
        <View className='kp-sheet-gap-xs' />
        <Text className='kp-export__line'>{exportGeneratedText(item)}</Text>
        <Text className='kp-export__line'>{`余额：${item.pointsBalance} 分`}</Text>
        <Text className='kp-export__line'>
          {`文件格式版本：v${item.schemaVersion}（生成方 ${item.generator}）`}
        </Text>
        <Text className='kp-export__line'>{`文件名：${exportFileName(item)}`}</Text>
        {!exportIsKnownSchemaVersion(item) ? (
          <Text className='kp-export__warn'>
            {`这份文件来自更新版本的服务端（格式版本高于当前客户端认识的 v${exportSchemaVersion}）。` +
              '文件本身可以照常复制，但当前界面可能认不全其中的字段。'}
          </Text>
        ) : null}
        {item.truncated ? (
          <Text className='kp-export__warn'>
            {`注意：这份文件不是全量。以下段被单次导出上限截断：${exportTruncatedSectionsText(
              item
            )}。请对照「文件内容」里的条数确认缺了多少。`}
          </Text>
        ) : null}
      </AppCard>
    )
  }

  const body = () => {
    if (!store.isLiveMode) {
      // 预览模式的数据是演示用的，不存在「服务端的这份文件」——
      // 编一份 JSON 给家长复制会让人以为真实数据已经备份。
      return hint(
        '预览模式没有真实的家庭数据，这里没有可导出的文件。接入后端后才能导出。'
      )
    }
    if (store.selfMember === null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：既不能给导出按钮，
      // 也不能说「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return unknownRoleRows()
    }
    if (!canExport) {
      return hint(
        `你的身份是${memberRoleLabelOf(store.selfMember.role)}，不能导出家庭数据。\n` +
          '需要备份时，请让家里的家长在「我的 → 导出家庭数据」里操作。'
      )
    }

    if (file !== null) {
      return (
        <View>
          {busy ? (
            <View className='kp-invite__status'>
              <Text className='kp-invite__status-text'>
                正在重新生成导出文件…
              </Text>
            </View>
          ) : null}
          {/*
            刷新失败但手里还有上一次的文件：**两件事都要说**。
            只显示旧文件 = 家长会以为这就是刚生成的（甚至以为权限还在）；
            只显示错误 = 刚复制过的文件凭空消失。
          */}
          {store.exportReadStatus === 'error' ? (
            <View>
              {errorCard(exportError)}
              <View className='kp-sheet-gap-md' />
              {hint(
                `下面是上一次成功生成的文件（${exportGeneratedText(
                  file
                )}），可能已经过期。刷新失败不会删掉它，但请不要把它当成刚导出的副本。`
              )}
              <View className='kp-sheet-gap-md' />
            </View>
          ) : null}
          {fileCard(file)}
          <View className='kp-sheet-gap-md' />
          {sectionCard(file)}
          <View className='kp-sheet-gap-md' />
          {actions(file)}
          {hint(
            '导出会读取孩子的档案、家庭成员、规则与版本、习惯、心愿、积分流水、' +
              '审批、同意记录与审计日志。文件里不含设备标识、登录凭据或密码散列。'
          )}
          {hint(
            '导出不受同意状态限制：即使撤回了监护人同意，也仍然可以导出这份文件。'
          )}
        </View>
      )
    }

    if (store.exportReadStatus === 'error') {
      return errorCard(exportError)
    }
    return hint(
      store.exportReadStatus === 'loading'
        ? '正在生成导出文件…（流水与审计较多时需要几秒）'
        : '还没有开始生成导出文件。'
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='导出家庭数据'
      subtitle={
        canExport
          ? '把这一个孩子的全部数据导成一份 JSON 文件'
          : '只有家长可以导出家庭数据'
      }
      onClose={onClose}
    >
      {body()}
    </SheetFrame>
  )
}

/** 字节数 → 「12.3 KB」。只用于提示，不参与任何判断。 */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * 真实 UTF-8 字节数。
 *
 * `String.length` 是 **UTF-16 码元数**，中文按 1 计；拿它当字节数会把
 * 中文昵称 / 规则标题占多数的导出文件低估三分之一以上（提示写 12 KB、
 * 实际 40 KB）。这里按码元逐个数宽度，**不额外复制**整份字符串
 * （`new TextEncoder().encode()` 会再复制一份，大文件在低端机上更糟）。
 */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4 // 代理对：高位 + 低位共 4 字节
      i += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

