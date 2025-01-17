import uuid4 from 'uuid/v4'
import MD5 from 'crypto-js/md5'
import { VM } from 'vm2'
import cheerio from 'cheerio'
import * as queryString from 'query-string'
import log from '@/modules/log'
import requester from '@/modules/requester'
import DanmakuClient from './danmaku_client'
import { Platform } from 'const'

// Variables
// =============================================================================

const signCaches = {}

// 因为斗鱼的sign混淆中会去验证一些window/document的函数是否是native的 (以此判断是否是浏览器环境), 所以这里直接proxy返回
const disguisedNative = new Proxy({}, {
  get: function (target, name) {
    return 'function () { [native code] }'
  }
})

// Exports
// =============================================================================

/* eslint-disable no-useless-computed-key */
export const qualities = {
  // Data: Chinese (这里一致是因为数据和中文就是一样的)
  ['流畅']: '流畅',
  ['高清']: '高清',
  ['超清']: '超清',
  ['蓝光']: '蓝光',
  ['蓝光4M']: '蓝光4M',
  ['蓝光8M']: '蓝光8M',
  ['蓝光10M']: '蓝光10M'
}
/* eslint-enable no-useless-computed-key */

export const circuits = {
  'ws': '主线 (网宿)',
  'ws-h5': '主线-H5 (网宿)',
  'tct': '备用线路5 (腾讯云)',
  'tct-h5': '备用线路5-H5 (腾讯云)',
  'ali-h5': '备用线路6 (阿里云)',
  'ws2': '备用线路2 (网宿2)',
  'dl': '备用线路3 (帝联)'
}

export const preferred = {
  quality: '超清',
  circuit: 'ws-h5'
}

export giftMap from './gift_map'

export function getUrl (address) {
  let base = 'https://www.douyu.com/'
  return new URL(base + address)
}

export function addressValidator (rule, address, callback) {
  if (!/^\d+$/.test(address)) return callback(new Error('In not a valid address'))
  callback()
}

export function canParse (address) {
  return /https?:\/\/(?:.*?\.)?douyu.com\//.test(address)
}

export async function parseAddress (address) {
  if (canParse(address)) {
    address = address.trim()
    let html = await requester.get(address)
    let $ = cheerio.load(html)

    let result = {
      platform: Platform.DouYu,
      alias: $('.Title-anchorName').text()
    }

    if (!result.alias) {
      let keywordText = $('meta[name=keywords]').attr('content')
      if (keywordText) {
        let keywords = keywordText.split(',')
        result.alias = keywords[0]
      }
    }

    let scriptNode = $('script').map((i, tag) => tag.children[0]).filter((i, tag) => tag.data.includes('$ROOM'))[0]
    if (!scriptNode) return
    let matched = scriptNode.data.match(/\$ROOM\.room_id.?=(.*?);/)
    if (!matched) return
    result.address = matched[1].trim()

    return result
  }
}

export async function getInfo (address) {
  let response = await requester.get(`http://open.douyucdn.cn/api/RoomApi/room/${address}`, {
    resolveWithFullResponse: true,
    simple: false,
    json: true
  })

  if (response.statusCode !== 200) {
    if (response.statusCode === 404 && response.body === 'Not Found') {
      throw new Error('错误的地址 ' + address)
    }

    throw new Error(`Unexpected status code, ${response.statusCode}, ${response.body}`)
  }

  let json = response.body
  if (json.error === 101) throw new Error('错误的地址 ' + address)
  if (json.error !== 0) throw new Error('Unexpected error code, ' + json.error)

  return {
    living: json.data.room_status === '1',
    owner: json.data.owner_name,
    title: json.data.room_name,
    startTime: new Date(json.data.start_time)
  }
}

export async function getStream (address, quality, circuit, opts = {}) {
  let sign = await getSignFn(address, opts.rejectCache)
  let did = uuid4().replace(/-/g, '')
  let time = Math.ceil(Date.now() / 1000)
  let signed = sign(address, did, time)
  signed = queryString.parse(signed)

  let response = await requester.post(`https://www.douyu.com/lapi/live/getH5Play/${address}`, {
    resolveWithFullResponse: true,
    simple: false,
    json: true,
    form: Object.assign({}, signed, {
      cdn: circuit,
      rate: opts.rate || 0,
      iar: 0,
      ive: 0
    })
  })

  if (response.statusCode !== 200) {
    if (response.statusCode === 403 && response.body === '鉴权失败' && !opts.rejectCache) {
      // 使用非缓存的sign函数再次签名
      return getStream(address, quality, circuit, Object.assign({}, opts, { rejectCache: true }))
    }

    throw new Error(`Unexpected status code, ${response.statusCode}, ${response.body}`)
  }

  let json = response.body
  // 不存在的房间, 已被封禁, 未开播
  if ([-3, -4, -5].includes(json.error)) return
  // 时间戳错误, 目前不确定原因, 但重新获取几次sign函数可解决 (这里不return, 继续往下弹提示)
  if (json.error === -9) delete signCaches[address]
  // 其他
  if (json.error !== 0) {
    log.error('Unexpected error code', json)
    throw new Error('Unexpected error code, ' + json.error)
  }

  // 检测是否支持指定的画质
  let target = json.data.multirates.find(obj => obj.name === quality)
  if (target && json.data.rate !== target.rate) {
    // 切换到目标画质
    return getStream(address, quality, circuit, Object.assign({}, opts, { rate: target.rate }))
  }

  // 实际使用的画质
  if (!target) quality = json.data.multirates.find(obj => obj.rate === json.data.rate).name
  // 实际使用的线路
  circuit = json.data.rtmp_cdn

  return {
    stream: `${json.data.rtmp_url}/${json.data.rtmp_live}`,
    quality,
    circuit,
    qualityCN: qualities[quality],
    circuitCN: circuits[circuit]
  }
}

export function getDanmakuClient (address) {
  return new DanmakuClient(address)
}

// Utils
// =============================================================================

/* eslint-disable no-new-func */
async function getSignFn (address, rejectCache) {
  if (!rejectCache && signCaches.hasOwnProperty(address)) {
    // 有缓存, 直接使用
    return signCaches[address]
  }

  let json = await requester.get('https://www.douyu.com/swf_api/homeH5Enc?rids=' + address, { json: true })
  if (json.error !== 0) throw new Error('Unexpected error code, ' + json.error)
  let code = json.data && json.data['room' + address]
  if (!code) throw new Error('Unexpected result with homeH5Enc, ' + JSON.stringify(json))

  const vm = new VM({
    sandbox: {
      CryptoJS: { MD5 },
      window: disguisedNative,
      document: disguisedNative
    }
  })
  let sign = vm.run(code + ';ub98484234')
  signCaches[address] = sign

  return sign
}
/* eslint-enable no-new-func */
