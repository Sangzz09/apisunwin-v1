import express from "express"
import axios from "axios"
import cors from "cors"

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000
const SOURCE = "https://meuni-basally-xzavier.ngrok-free.dev/api/history"

let history = []
let predictionLog = []
let lastLoadedLength = 0 // FIX #4: track length để updateWeights đúng lúc

// ============================================================
// UTILS
// ============================================================
function sumDice(d) {
  return d.reduce((a, b) => a + b, 0)
}

function taiXiu(t) {
  return t >= 11 ? "Tài" : "Xỉu"
}

function toResults(historyArr) {
  return historyArr.map(v => {
    // Ưu tiên field result đã có sẵn
    if (v.result) return v.result
    if (v.Ket_qua) return v.Ket_qua
    // Fallback tính từ dice
    const d = v.dice || [v.Xuc_xac_1, v.Xuc_xac_2, v.Xuc_xac_3] || [1, 1, 1]
    return taiXiu(sumDice(d))
  })
}

// ============================================================
// 1. MARKOV CHAIN (bậc 2)
// ============================================================
function markov(data) {
  const map1 = { Tài: { Tài: 0, Xỉu: 0 }, Xỉu: { Tài: 0, Xỉu: 0 } }
  for (let i = 0; i < data.length - 1; i++) {
    map1[data[i]][data[i + 1]]++
  }

  const map2 = {}
  for (let i = 0; i < data.length - 2; i++) {
    const key = data[i] + "_" + data[i + 1]
    if (!map2[key]) map2[key] = { Tài: 0, Xỉu: 0 }
    map2[key][data[i + 2]]++
  }

  const last2 = data.slice(-2).join("_")
  let vote = null

  if (map2[last2]) {
    const m = map2[last2]
    const total = m.Tài + m.Xỉu
    if (total >= 3) {
      vote = m.Tài > m.Xỉu ? "Tài" : "Xỉu"
      return { vote, confidence: Math.max(m.Tài, m.Xỉu) / total }
    }
  }

  const last = data[data.length - 1]
  const m = map1[last]
  const total = m.Tài + m.Xỉu
  if (total === 0) return { vote: "Tài", confidence: 0.5 }
  vote = m.Tài > m.Xỉu ? "Tài" : "Xỉu"
  return { vote, confidence: Math.max(m.Tài, m.Xỉu) / total }
}

// ============================================================
// 2. TREND
// ============================================================
function trend(data) {
  const w = data.slice(-15)
  let tScore = 0, xScore = 0
  w.forEach((v, i) => {
    const weight = i + 1
    if (v === "Tài") tScore += weight
    else xScore += weight
  })
  const total = tScore + xScore
  const vote = tScore >= xScore ? "Tài" : "Xỉu"
  return { vote, confidence: Math.max(tScore, xScore) / total }
}

// ============================================================
// 3. STREAK - FIX #6: phân biệt streak 1 và 2
// ============================================================
function streak(data) {
  const last = data[data.length - 1]
  let count = 0
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === last) count++
    else break
  }

  let vote
  if (count >= 5) {
    vote = last // xu hướng mạnh, tiếp tục
  } else if (count >= 3) {
    vote = last === "Tài" ? "Xỉu" : "Tài" // đảo chiều sau 3-4
  } else if (count === 2) {
    vote = last === "Tài" ? "Xỉu" : "Tài" // FIX: streak 2 → có xu hướng đảo
  } else {
    vote = last // streak 1: giữ nguyên
  }

  // Confidence tăng dần theo độ dài streak có ý nghĩa
  let confidence = 0.51
  if (count >= 5) confidence = 0.67
  else if (count >= 3) confidence = 0.65
  else if (count === 2) confidence = 0.57

  return { vote, confidence, streakLen: count }
}

// ============================================================
// 4. FREQUENCY - FIX #3: đổi tên biến 'x' → 'xCount'
// ============================================================
function frequency(data) {
  const recent = data.slice(-50)
  const tCount = recent.filter(v => v === "Tài").length
  const xCount = recent.length - tCount // FIX: không còn shadow tên
  const ratio = tCount / recent.length
  let vote, confidence

  if (ratio > 0.65) { vote = "Xỉu"; confidence = ratio }
  else if (ratio < 0.35) { vote = "Tài"; confidence = 1 - ratio }
  else {
    const last5 = data.slice(-5)
    const t5 = last5.filter(v => v === "Tài").length
    vote = t5 >= 3 ? "Tài" : "Xỉu"
    confidence = 0.5
  }
  return { vote, confidence }
}

// ============================================================
// 5. MOMENTUM
// ============================================================
function momentum(data) {
  const l = data.slice(-8)
  let score = 0
  const decay = 0.85
  l.forEach((v, i) => {
    const w = Math.pow(decay, l.length - 1 - i)
    if (v === "Tài") score += w
    else score -= w
  })
  const maxScore = l.reduce((s, _, i) => s + Math.pow(decay, i), 0)
  const vote = score > 0 ? "Tài" : "Xỉu"
  const confidence = 0.5 + Math.abs(score) / maxScore * 0.3
  return { vote, confidence }
}

// ============================================================
// 6. PATTERN MATCHING
// ============================================================
function patternMatch(data) {
  const patterns = {
    "TàiXỉuTàiXỉu": "Tài",
    "XỉuTàiXỉuTài": "Xỉu",
    "TàiTàiXỉuXỉu": "Tài",
    "XỉuXỉuTàiTài": "Xỉu",
    "TàiTàiTàiXỉu": "Xỉu",
    "XỉuXỉuXỉuTài": "Tài",
    "TàiTàiTàiTài": "Xỉu",
    "XỉuXỉuXỉuXỉu": "Tài",
    "XỉuTàiTàiTàiXỉu": "Tài",
    "TàiXỉuXỉuXỉuTài": "Xỉu",
  }

  for (let len = 5; len >= 3; len--) {
    const key = data.slice(-len).join("")
    if (patterns[key]) {
      return { vote: patterns[key], confidence: 0.68, detected: key }
    }
  }
  return { vote: null, confidence: 0, detected: null }
}

// ============================================================
// 7. BAYESIAN
// ============================================================
function bayesian(data) {
  const n = Math.min(data.length, 100)
  const recent = data.slice(-n)

  const tTotal = recent.filter(v => v === "Tài").length
  const priorT = tTotal / n

  const last3 = data.slice(-3).join(",")
  const seqs = []
  for (let i = 0; i < recent.length - 3; i++) {
    seqs.push({
      key: recent.slice(i, i + 3).join(","),
      next: recent[i + 3]
    })
  }

  const matched = seqs.filter(s => s.key === last3)
  if (matched.length >= 4) {
    const tAfter = matched.filter(s => s.next === "Tài").length
    const prob = tAfter / matched.length
    const vote = prob > 0.5 ? "Tài" : "Xỉu"
    const confidence = Math.abs(prob - 0.5) * 2 * 0.4 + 0.5
    return { vote, confidence }
  }

  const vote = priorT > 0.5 ? "Tài" : "Xỉu"
  return { vote, confidence: Math.abs(priorT - 0.5) * 2 * 0.2 + 0.5 }
}

// ============================================================
// 8. ENTROPY - FIX #5: entropy trung bình theo trend thay vì đảo
// ============================================================
function entropyAnalysis(data) {
  const w = data.slice(-20)
  let switches = 0
  for (let i = 1; i < w.length; i++) {
    if (w[i] !== w[i - 1]) switches++
  }
  const entropyRatio = switches / (w.length - 1)

  if (entropyRatio > 0.7) {
    // Hỗn loạn: theo short trend
    const last3 = data.slice(-3)
    const t = last3.filter(v => v === "Tài").length
    return { vote: t >= 2 ? "Tài" : "Xỉu", confidence: 0.54, entropy: entropyRatio }
  } else if (entropyRatio < 0.3) {
    // Xu hướng mạnh: theo streak
    const last = data[data.length - 1]
    return { vote: last, confidence: 0.62, entropy: entropyRatio }
  }

  // FIX: entropy trung bình → theo weighted trend ngắn thay vì đảo ngẫu nhiên
  const last5 = data.slice(-5)
  const tCount = last5.filter(v => v === "Tài").length
  const vote = tCount >= 3 ? "Tài" : "Xỉu"
  return { vote, confidence: 0.53, entropy: entropyRatio }
}

// ============================================================
// 9. ADAPTIVE WEIGHT
// ============================================================
const algorithmWeights = {
  markov: 1.0,
  trend: 1.0,
  streak: 1.0,
  frequency: 0.8,
  momentum: 1.0,
  pattern: 1.5,
  bayesian: 1.2,
  entropy: 0.9,
}

function updateWeights(log) {
  if (log.length < 10) return

  const recent = log.slice(-30)
  const algos = Object.keys(algorithmWeights)

  algos.forEach(algo => {
    let correct = 0, total = 0
    recent.forEach(entry => {
      if (entry.votes && entry.votes[algo] && entry.actual) {
        total++
        if (entry.votes[algo] === entry.actual) correct++
      }
    })
    if (total >= 5) {
      const acc = correct / total
      algorithmWeights[algo] = Math.max(0.3, Math.min(2.0, acc * 2))
    }
  })
}

// ============================================================
// 10. ENSEMBLE AI
// ============================================================
function aiPredict(results) {
  if (results.length < 10) {
    return { predict: "Tài", conf: 50, pattern: "insufficient_data", detail: {} }
  }

  const mk = markov(results)
  const tr = trend(results)
  const sk = streak(results)
  const fr = frequency(results)
  const mm = momentum(results)
  const pt = patternMatch(results)
  const by = bayesian(results)
  const en = entropyAnalysis(results)

  const votes = {
    markov: mk.vote,
    trend: tr.vote,
    streak: sk.vote,
    frequency: fr.vote,
    momentum: mm.vote,
    pattern: pt.vote,
    bayesian: by.vote,
    entropy: en.vote,
  }

  const confidences = {
    markov: mk.confidence,
    trend: tr.confidence,
    streak: sk.confidence,
    frequency: fr.confidence,
    momentum: mm.confidence,
    pattern: pt.detected ? pt.confidence : 0.5,
    bayesian: by.confidence,
    entropy: en.confidence,
  }

  let tScore = 0, xScore = 0
  Object.keys(votes).forEach(algo => {
    if (!votes[algo]) return
    const w = algorithmWeights[algo] * (confidences[algo] || 0.5)
    if (votes[algo] === "Tài") tScore += w
    else xScore += w
  })

  const total = tScore + xScore
  const predict = tScore > xScore ? "Tài" : "Xỉu"
  const rawConf = Math.max(tScore, xScore) / total
  const conf = Math.round(50 + rawConf * 35)

  const validVotes = Object.values(votes).filter(Boolean)
  const tVotes = validVotes.filter(v => v === "Tài").length
  const xVotes = validVotes.length - tVotes
  const consensus = Math.abs(tVotes - xVotes) / validVotes.length

  let signal = "weak"
  if (consensus >= 0.6) signal = "strong"
  else if (consensus >= 0.35) signal = "moderate"

  return {
    predict,
    conf,
    signal,
    pattern: pt.detected ? `pattern:${pt.detected}` : "normal",
    streak_len: sk.streakLen,
    entropy: Math.round(en.entropy * 100) + "%",
    votes,
    weights: { ...algorithmWeights },
    tScore: Math.round(tScore * 100) / 100,
    xScore: Math.round(xScore * 100) / 100,
  }
}

// ============================================================
// FETCH DATA - FIX: thêm headers ngrok, retry logic, log lỗi
// ============================================================
let loadErrorCount = 0

async function load() {
  try {
    const r = await axios.get(SOURCE, {
      timeout: 6000,
      headers: {
        // FIX: bypass ngrok browser warning page
        "ngrok-skip-browser-warning": "true",
        "User-Agent": "SicboAI/2.0",
        "Accept": "application/json",
      }
    })

    // FIX: kiểm tra content-type để tránh nhận HTML từ ngrok warning
    const contentType = r.headers["content-type"] || ""
    if (!contentType.includes("application/json")) {
      console.error("❌ Nguồn trả về không phải JSON, có thể là trang ngrok warning")
      return
    }

    const body = r.data

    // Parse current session từ body.current
    const cur = body.current
    if (!cur) {
      console.error("❌ Thiếu trường 'current':", JSON.stringify(body).slice(0, 200))
      return
    }

    // Parse history array
    let rawHistory = body.history
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
      console.error("❌ Thiếu hoặc rỗng trường 'history'")
      return
    }

    // Normalize current thành cùng format với history items
    const currentItem = {
      session: cur.Phien,
      dice: [cur.Xuc_xac_1, cur.Xuc_xac_2, cur.Xuc_xac_3],
      total: cur.Tong,
      result: cur.Ket_qua,
      timestamp: cur.server_time,
    }

    // Ghép history + current (tránh trùng nếu đã có)
    const lastHistSession = rawHistory[rawHistory.length - 1]?.session
    if (lastHistSession !== currentItem.session) {
      rawHistory = [...rawHistory, currentItem]
    }

    const newHistory = rawHistory.slice(-300)
    loadErrorCount = 0

    // FIX #4: updateWeights theo phiên ID
    const latestPhien = currentItem.session

    if (predictionLog.length > 0) {
      const lastEntry = predictionLog[predictionLog.length - 1]
      if (!lastEntry.actual && lastEntry.phien !== latestPhien) {
        lastEntry.actual = currentItem.result
        updateWeights(predictionLog)
        console.log(`✅ Actual phiên ${lastEntry.phien}: ${lastEntry.actual}`)
      }
    }

    history = newHistory
    console.log(`📦 Phiên ${currentItem.session} | ${currentItem.result} | Tổng ${currentItem.total} | ${history.length} phiên`)
  } catch (e) {
    loadErrorCount++
    if (e.response) {
      console.error(`❌ HTTP ${e.response.status}: ${e.response.statusText}`)
    } else if (e.code === "ECONNABORTED") {
      console.error("❌ Timeout khi tải dữ liệu nguồn")
    } else {
      console.error("❌ Lỗi load:", e.message)
    }

    // Retry nhanh hơn nếu lỗi liên tiếp < 5 lần
    if (loadErrorCount <= 5) {
      setTimeout(load, 2000)
    }
  }
}

load()
setInterval(load, 5000)

// ============================================================
// API ROUTES
// ============================================================

app.get("/api", (req, res) => {
  if (history.length === 0) {
    return res.status(503).json({ error: "no_data", message: "Chưa có dữ liệu từ nguồn" })
  }

  const last = history[history.length - 1]
  const dice = last.dice || last.xucxac || [1, 1, 1]
  const total = sumDice(dice)
  const result = taiXiu(total)
  const arr = toResults(history)
  const ai = aiPredict(arr)

  const currentPhien = last.session || last.phien || history.length

  // FIX #2: chỉ push log khi phiên thực sự mới
  const lastLog = predictionLog[predictionLog.length - 1]
  if (!lastLog || lastLog.phien !== currentPhien) {
    predictionLog.push({
      phien: currentPhien,
      predict: ai.predict,
      actual: null,
      votes: ai.votes,
      timestamp: Date.now()
    })
    if (predictionLog.length > 200) predictionLog.shift()
  }

  res.json({
    phien: currentPhien,
    ket_qua: dice,
    tong: total,
    result,
    du_doan: ai.predict,
    do_tin_cay: ai.conf + "%",
    tin_hieu: ai.signal,
    pattern: ai.pattern,
    streak: ai.streak_len,
    entropy: ai.entropy,
    id: "@sewdangcap"
  })
})

app.get("/api/detail", (req, res) => {
  if (history.length === 0) {
    return res.status(503).json({ error: "no_data" })
  }

  const arr = toResults(history)
  const ai = aiPredict(arr)

  res.json({
    total_sessions: history.length,
    ai_detail: ai,
    recent_10: arr.slice(-10),
    algorithm_weights: algorithmWeights,
  })
})

app.get("/api/accuracy", (req, res) => {
  const evaluated = predictionLog.filter(e => e.actual)
  if (evaluated.length === 0) {
    return res.json({ message: "Chưa đủ dữ liệu để đánh giá", total: 0 })
  }

  const correct = evaluated.filter(e => e.predict === e.actual).length
  const accuracy = Math.round((correct / evaluated.length) * 100)

  const algoStats = {}
  Object.keys(algorithmWeights).forEach(algo => {
    const algoEval = evaluated.filter(e => e.votes && e.votes[algo])
    const algoCorrect = algoEval.filter(e => e.votes[algo] === e.actual).length
    algoStats[algo] = {
      accuracy: algoEval.length > 0 ? Math.round((algoCorrect / algoEval.length) * 100) + "%" : "N/A",
      weight: Math.round(algorithmWeights[algo] * 100) / 100
    }
  })

  res.json({
    total_evaluated: evaluated.length,
    correct,
    accuracy: accuracy + "%",
    algorithm_stats: algoStats,
    recent_20: evaluated.slice(-20).map(e => ({
      phien: e.phien,
      predict: e.predict,
      actual: e.actual,
      correct: e.predict === e.actual
    }))
  })
})

// ============================================================
// CẦU NHẬN DẠNG
// ============================================================
function detectCau(arr) {
  if (arr.length < 4) return { name: "chưa_đủ_dữ_liệu", predict: arr[arr.length - 1] || "Tài" }

  const w = arr.slice(-12)

  // ---- Cầu bệt: cùng kết quả liên tiếp >= 3 ----
  let betLen = 1
  for (let i = w.length - 2; i >= 0; i--) {
    if (w[i] === w[w.length - 1]) betLen++
    else break
  }
  if (betLen >= 3) {
    return {
      name: "cầu_bệt",
      predict: w[w.length - 1],
      streak: betLen
    }
  }

  // ---- Cầu đan xen: T X T X T X ----
  const last6 = w.slice(-6)
  const isAlternating = last6.length >= 4 && last6.every((v, i) => i === 0 || v !== last6[i - 1])
  if (isAlternating) {
    const next = last6[last6.length - 1] === "Tài" ? "Xỉu" : "Tài"
    return { name: "cầu_đan_xen", predict: next }
  }

  // ---- Cầu 1-2: T XX T XX hoặc X TT X TT ----
  const last6str = w.slice(-6).join(",")
  const p12 = ["Tài,Xỉu,Xỉu,Tài,Xỉu,Xỉu", "Xỉu,Tài,Tài,Xỉu,Tài,Tài"]
  if (p12.includes(last6str)) {
    // T XX → tiếp theo là T; X TT → tiếp theo là X
    const next = w[w.length - 1] === "Xỉu" ? "Tài" : "Xỉu"
    return { name: "cầu_1_2", predict: next }
  }

  // ---- Cầu 2-1: TT X TT X hoặc XX T XX T ----
  // FIX #1: sau X (kết thúc chu kỳ 2-1) thì tiếp theo là TT → predict T
  const p21 = ["Tài,Tài,Xỉu,Tài,Tài,Xỉu", "Xỉu,Xỉu,Tài,Xỉu,Xỉu,Tài"]
  if (p21.includes(last6str)) {
    // Vừa kết thúc chu kỳ X/T đơn → bắt đầu cặp mới
    const pairVal = w[w.length - 1] === "Xỉu" ? "Tài" : "Xỉu"
    return { name: "cầu_2_1", predict: pairVal }
  }

  // ---- Cầu 2-2: TT XX TT XX ----
  const last8 = w.slice(-8).join(",")
  const p22 = ["Tài,Tài,Xỉu,Xỉu,Tài,Tài,Xỉu,Xỉu", "Xỉu,Xỉu,Tài,Tài,Xỉu,Xỉu,Tài,Tài"]
  if (p22.includes(last8)) {
    return { name: "cầu_2_2", predict: w[w.length - 1] }
  }

  // ---- Cầu 3-3: TTT XXX TTT hoặc XXX TTT XXX ----
  const last9 = w.slice(-9).join(",")
  const p33 = [
    "Tài,Tài,Tài,Xỉu,Xỉu,Xỉu,Tài,Tài,Tài",
    "Xỉu,Xỉu,Xỉu,Tài,Tài,Tài,Xỉu,Xỉu,Xỉu"
  ]
  if (p33.includes(last9)) {
    return { name: "cầu_3_3", predict: w[w.length - 1] }
  }

  // ---- Cầu gãy: vừa đổi từ streak 2 ----
  if (betLen === 2) {
    const beforeStreak = w[w.length - 3]
    const streakVal = w[w.length - 1]
    if (beforeStreak && beforeStreak !== streakVal) {
      return { name: "cầu_gãy", predict: streakVal }
    }
  }

  return { name: "không_rõ_cầu", predict: null }
}

// GET /sunlon
app.get("/sunlon", (req, res) => {
  if (history.length === 0) {
    return res.status(503).json({ error: "no_data", message: "Chưa có dữ liệu từ nguồn" })
  }

  const last = history[history.length - 1]
  const dice = last.dice || last.xucxac || [1, 1, 1]
  const total = sumDice(dice)
  const result = taiXiu(total)
  const arr = toResults(history)

  const cau = detectCau(arr)

  let duDoan = cau.predict
  let doTinCay = "65%"
  let usedAI = false

  if (!duDoan) {
    const ai = aiPredict(arr)
    duDoan = ai.predict
    doTinCay = ai.conf + "%"
    usedAI = true
  } else {
    const cauConfMap = {
      "cầu_bệt": 70,
      "cầu_đan_xen": 68,
      "cầu_1_2": 66,
      "cầu_2_1": 66,
      "cầu_2_2": 67,
      "cầu_3_3": 69,
      "cầu_gãy": 62,
    }
    doTinCay = (cauConfMap[cau.name] || 60) + "%"
  }

  res.json({
    phien: last.session || last.phien || history.length,
    ket_qua: dice,
    tong: total,
    result,
    du_doan: duDoan,
    do_tin_cay: doTinCay,
    pattern: cau.name,
    used_ai_fallback: usedAI,
    id: "@sewdangcap"
  })
})

// GET /sunlon/detail
app.get("/sunlon/detail", (req, res) => {
  if (history.length === 0) {
    return res.status(503).json({ error: "no_data" })
  }

  const arr = toResults(history)
  const cau = detectCau(arr)
  const last10 = arr.slice(-10)

  res.json({
    cau_hien_tai: cau.name,
    du_doan_cau: cau.predict,
    streak: cau.streak || null,
    lich_su_10: last10,
    id: "@sewdangcap"
  })
})

// GET /api/history
app.get("/api/history", (req, res) => {
  if (history.length === 0) {
    return res.status(503).json({ error: "no_data", message: "Chưa có dữ liệu" })
  }
  const arr = toResults(history)
  const last50 = arr.slice(-50)
  const tCount = last50.filter(v => v === "Tài").length
  res.json({
    total: history.length,
    recent_50: last50,
    tai_ratio: Math.round((tCount / last50.length) * 100) + "%",
    xiu_ratio: Math.round(((last50.length - tCount) / last50.length) * 100) + "%"
  })
})

// GET /health - kiểm tra trạng thái server
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    history_loaded: history.length,
    prediction_log: predictionLog.length,
    load_errors: loadErrorCount,
    algorithm_weights: algorithmWeights,
    source: SOURCE
  })
})

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🎲 SICBO ULTRA AI v2 RUNNING on port ${PORT}`)
  console.log(`📡 Source: ${SOURCE}`)
})
