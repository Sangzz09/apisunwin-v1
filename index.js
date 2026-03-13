import express from "express"
import axios from "axios"
import cors from "cors"

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000
const SOURCE = "https://meuni-basally-xzavier.ngrok-free.dev/api/history"

let history = []
let predictionLog = [] // Lưu lịch sử dự đoán để đánh giá độ chính xác

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
    const d = v.dice || v.xucxac || [1, 1, 1]
    return taiXiu(sumDice(d))
  })
}

// ============================================================
// 1. MARKOV CHAIN (bậc 2 - xem 2 bước trước)
// ============================================================
function markov(data) {
  // Markov bậc 1
  const map1 = { Tài: { Tài: 0, Xỉu: 0 }, Xỉu: { Tài: 0, Xỉu: 0 } }
  for (let i = 0; i < data.length - 1; i++) {
    map1[data[i]][data[i + 1]]++
  }

  // Markov bậc 2
  const map2 = {}
  for (let i = 0; i < data.length - 2; i++) {
    const key = data[i] + "_" + data[i + 1]
    if (!map2[key]) map2[key] = { Tài: 0, Xỉu: 0 }
    map2[key][data[i + 2]]++
  }

  const last2 = data.slice(-2).join("_")
  let vote = null

  // Ưu tiên bậc 2 nếu có đủ dữ liệu
  if (map2[last2]) {
    const m = map2[last2]
    const total = m.Tài + m.Xỉu
    if (total >= 3) {
      vote = m.Tài > m.Xỉu ? "Tài" : "Xỉu"
      return { vote, confidence: Math.max(m.Tài, m.Xỉu) / total }
    }
  }

  // Fallback bậc 1
  const last = data[data.length - 1]
  const m = map1[last]
  const total = m.Tài + m.Xỉu
  if (total === 0) return { vote: "Tài", confidence: 0.5 }
  vote = m.Tài > m.Xỉu ? "Tài" : "Xỉu"
  return { vote, confidence: Math.max(m.Tài, m.Xỉu) / total }
}

// ============================================================
// 2. TREND - Xu hướng gần nhất (trọng số tăng dần)
// ============================================================
function trend(data) {
  const w = data.slice(-15)
  let tScore = 0, xScore = 0
  w.forEach((v, i) => {
    const weight = i + 1 // Càng gần càng có trọng số cao
    if (v === "Tài") tScore += weight
    else xScore += weight
  })
  const total = tScore + xScore
  const vote = tScore >= xScore ? "Tài" : "Xỉu"
  return { vote, confidence: Math.max(tScore, xScore) / total }
}

// ============================================================
// 3. STREAK - Phát hiện chuỗi và đảo chiều
// ============================================================
function streak(data) {
  const last = data[data.length - 1]
  let count = 0
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === last) count++
    else break
  }

  // Chuỗi 2: giữ nguyên; chuỗi 3-4: đảo; chuỗi 5+: giữ nguyên (có thể là xu hướng mạnh)
  let vote
  if (count >= 5) vote = last
  else if (count >= 3) vote = last === "Tài" ? "Xỉu" : "Tài"
  else vote = last

  const confidence = count >= 3 ? 0.65 : 0.52
  return { vote, confidence, streakLen: count }
}

// ============================================================
// 4. FREQUENCY - Cân bằng tần suất dài hạn
// ============================================================
function frequency(data) {
  const recent = data.slice(-50) // Chỉ xét 50 phiên gần nhất
  const t = recent.filter(x => x === "Tài").length
  const x = recent.length - t
  // Nếu một bên áp đảo, dự đoán bên còn lại sẽ bù
  const ratio = t / recent.length
  let vote, confidence

  if (ratio > 0.65) { vote = "Xỉu"; confidence = ratio }
  else if (ratio < 0.35) { vote = "Tài"; confidence = 1 - ratio }
  else {
    // Gần cân bằng, theo xu hướng gần hơn
    const last5 = data.slice(-5)
    const t5 = last5.filter(x => x === "Tài").length
    vote = t5 >= 3 ? "Tài" : "Xỉu"
    confidence = 0.5
  }
  return { vote, confidence }
}

// ============================================================
// 5. MOMENTUM - Động lượng có trọng số mũ
// ============================================================
function momentum(data) {
  const l = data.slice(-8)
  let score = 0
  const decay = 0.85 // Hệ số giảm dần
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
// 6. PATTERN MATCHING - Nhận dạng mẫu nâng cao
// ============================================================
function patternMatch(data) {
  const patterns = {
    // Alternating
    "TàiXỉuTàiXỉu": "Tài",
    "XỉuTàiXỉuTài": "Xỉu",
    // Double alternating
    "TàiTàiXỉuXỉu": "Tài",
    "XỉuXỉuTàiTài": "Xỉu",
    // Triple break
    "TàiTàiTàiXỉu": "Xỉu",
    "XỉuXỉuXỉuTài": "Tài",
    // Quad streak
    "TàiTàiTàiTài": "Xỉu",
    "XỉuXỉuXỉuXỉu": "Tài",
    // 5-pattern
    "XỉuTàiTàiTàiXỉu": "Tài",
    "TàiXỉuXỉuXỉuTài": "Xỉu",
  }

  // Tìm pattern khớp dài nhất
  for (let len = 5; len >= 3; len--) {
    const key = data.slice(-len).join("")
    if (patterns[key]) {
      return { vote: patterns[key], confidence: 0.68, detected: key }
    }
  }
  return { vote: null, confidence: 0, detected: null }
}

// ============================================================
// 7. BAYESIAN NAIVE - Xác suất Bayes đơn giản
// ============================================================
function bayesian(data) {
  const n = Math.min(data.length, 100)
  const recent = data.slice(-n)

  // Prior: tần suất toàn bộ
  const tTotal = recent.filter(x => x === "Tài").length
  const priorT = tTotal / n

  // Likelihood dựa trên 3 phiên gần nhất
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

  // Fallback về prior
  const vote = priorT > 0.5 ? "Tài" : "Xỉu"
  return { vote, confidence: Math.abs(priorT - 0.5) * 2 * 0.2 + 0.5 }
}

// ============================================================
// 8. ENTROPY / CHAOS DETECTION
// ============================================================
function entropyAnalysis(data) {
  const w = data.slice(-20)
  let switches = 0
  for (let i = 1; i < w.length; i++) {
    if (w[i] !== w[i - 1]) switches++
  }
  const entropyRatio = switches / (w.length - 1)

  // Entropy cao (> 0.7): thị trường hỗn loạn -> theo trend ngắn
  // Entropy thấp (< 0.3): thị trường có xu hướng rõ -> theo streak
  if (entropyRatio > 0.7) {
    // Hỗn loạn: dùng short trend
    const last3 = data.slice(-3)
    const t = last3.filter(x => x === "Tài").length
    return { vote: t >= 2 ? "Tài" : "Xỉu", confidence: 0.54, entropy: entropyRatio }
  } else if (entropyRatio < 0.3) {
    // Xu hướng mạnh: theo streak
    const last = data[data.length - 1]
    return { vote: last, confidence: 0.62, entropy: entropyRatio }
  }

  const last = data[data.length - 1]
  return { vote: last === "Tài" ? "Xỉu" : "Tài", confidence: 0.52, entropy: entropyRatio }
}

// ============================================================
// 9. ADAPTIVE WEIGHT - Tự điều chỉnh trọng số theo độ chính xác
// ============================================================
const algorithmWeights = {
  markov: 1.0,
  trend: 1.0,
  streak: 1.0,
  frequency: 0.8,
  momentum: 1.0,
  pattern: 1.5, // Pattern có trọng số cao hơn khi detected
  bayesian: 1.2,
  entropy: 0.9,
}

// Cập nhật trọng số dựa trên lịch sử đúng/sai
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
      // Điều chỉnh trọng số: acc 50% = 1.0, acc 70% = 1.4, acc 30% = 0.6
      algorithmWeights[algo] = Math.max(0.3, Math.min(2.0, acc * 2))
    }
  })
}

// ============================================================
// 10. ENSEMBLE AI - Tổng hợp tất cả thuật toán
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

  // Weighted voting
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

  // Normalize confidence vào khoảng thực tế hơn [50-85]
  const conf = Math.round(50 + rawConf * 35)

  // Đánh giá mức độ đồng thuận
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
// FETCH DATA
// ============================================================
async function load() {
  try {
    const r = await axios.get(SOURCE, { timeout: 4000 })
    if (Array.isArray(r.data)) {
      const newHistory = r.data.slice(-300)

      // Cập nhật prediction log nếu có dữ liệu mới
      if (newHistory.length > history.length && predictionLog.length > 0) {
        const lastEntry = predictionLog[predictionLog.length - 1]
        if (!lastEntry.actual) {
          const newLast = newHistory[newHistory.length - 1]
          const d = newLast.dice || newLast.xucxac || [1, 1, 1]
          lastEntry.actual = taiXiu(sumDice(d))
          updateWeights(predictionLog)
        }
      }

      history = newHistory
    }
  } catch (e) {
    // Silent fail
  }
}

load()
setInterval(load, 5000)

// ============================================================
// API ROUTES
// ============================================================

// GET /api - Dự đoán chính
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

  // Lưu dự đoán vào log
  predictionLog.push({
    phien: last.session || last.phien || history.length,
    predict: ai.predict,
    actual: null,
    votes: ai.votes,
    timestamp: Date.now()
  })
  if (predictionLog.length > 200) predictionLog.shift()

  res.json({
    phien: last.session || last.phien || history.length,
    ket_qua: dice,
    tong: total,
    result,
    du_doan: ai.predict,
    do_tin_cay: ai.conf + "%",
    tin_hieu: ai.signal,      // strong / moderate / weak
    pattern: ai.pattern,
    streak: ai.streak_len,
    entropy: ai.entropy,
    id: "@sewdangcap"
  })
})

// GET /api/detail - Chi tiết đầy đủ
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

// GET /api/accuracy - Thống kê độ chính xác
app.get("/api/accuracy", (req, res) => {
  const evaluated = predictionLog.filter(e => e.actual)
  if (evaluated.length === 0) {
    return res.json({ message: "Chưa đủ dữ liệu để đánh giá", total: 0 })
  }

  const correct = evaluated.filter(e => e.predict === e.actual).length
  const accuracy = Math.round((correct / evaluated.length) * 100)

  // Accuracy theo từng thuật toán
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

// GET /api/history - 50 phiên gần nhất đã xử lý
app.get("/api/history", (req, res) => {
  const arr = toResults(history)
  const last50 = arr.slice(-50)
  const tCount = last50.filter(x => x === "Tài").length
  res.json({
    total: history.length,
    recent_50: last50,
    tai_ratio: Math.round((tCount / last50.length) * 100) + "%",
    xiu_ratio: Math.round(((last50.length - tCount) / last50.length) * 100) + "%"
  })
})

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🎲 SICBO ULTRA AI v2 RUNNING on port ${PORT}`)
  console.log(`📡 Source: ${SOURCE}`)
})
