import React, { useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'

const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'

function useSocket() {
  // Allow both websocket and polling so it works even if websockets are blocked
  const socket = useMemo(() => io(backendUrl, { transports: ['websocket', 'polling'], path: '/socket.io', reconnection: true }), [])
  useEffect(() => () => socket.disconnect(), [socket])
  const join = (pollId, role, name, durationSec) => socket.emit('join_poll', { pollId, role, name, durationSec })
  return { socket, join }
}

function PercentageBar({ label, value, total }) {
  const percent = total === 0 ? 0 : Math.round((value / total) * 100)
  return (
    <div className="bar">
      <div className="bar-label">{label}</div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="bar-percent">{percent}%</div>
    </div>
  )
}

function Results({ options, results }) {
  const total = (results || []).reduce((a, b) => a + b, 0)
  return (
    <div className="results">
      {(options || []).map((opt, i) => (
        <PercentageBar key={i} label={opt} value={results?.[i] || 0} total={total} />
      ))}
    </div>
  )
}

export default function App() {
  const [role, setRole] = useState(null)
  const [pollId, setPollId] = useState('class-101')
  const { socket, join } = useSocket()
  const [name, setName] = useState(localStorage.getItem('lp_name') || '')
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', '', '', ''])
  const [duration, setDuration] = useState(60)
  const [state, setState] = useState({ active: false, options: [], question: '', results: [], startedAt: null, durationSec: 60 })
  const [partial, setPartial] = useState(null)
  const [history, setHistory] = useState([])
  const [students, setStudents] = useState([])
  const [tick, setTick] = useState(0) // forces re-render for countdown

  // socket listeners
  useEffect(() => {
    function onNewQuestion(payload) {
      setPartial(null)
      setState(prev => ({ ...prev, ...payload, active: true, results: Array(payload.options.length).fill(0) }))
    }
    function onResults(payload) {
      setState(s => ({ ...s, active: false, results: payload.results }))
    }
    function onPartial(payload) {
      setPartial(payload)
    }
  function onPollState(s) { 
  console.log('poll_state', s)
  setState(prev => ({
    ...prev,
    ...s,
    active: s.active && !!s.question, // ensure active is true only if question exists
    results: Array(s.options?.length || 0).fill(0)
  })) 
}
    function onStudents(list) { setStudents(list) }
    function onHistory(h) { setHistory(h) }

    socket.on('joined', (p)=>{ console.log('joined', p); socket.emit('get_state', { pollId: p?.pollId }) })
    socket.on('new_question', onNewQuestion)
    socket.on('results', onResults)
    socket.on('partial_results', onPartial)
    socket.on('poll_state', onPollState)
    socket.on('students_update', onStudents)
    socket.on('history', onHistory)
    socket.on('error_message', (m) => {
      alert(m)
      // If student tried to join before teacher created poll, reset so they can rejoin
      setRole(null)
    })
    return () => {
      socket.off('joined')
      socket.off('new_question', onNewQuestion)
      socket.off('results', onResults)
      socket.off('partial_results', onPartial)
      socket.off('poll_state', onPollState)
      socket.off('students_update', onStudents)
      socket.off('history', onHistory)
    }
    // eslint-disable-next-line
  }, [socket])

  const handleJoinAsTeacher = () => {
    setRole('teacher'); join(pollId, 'teacher', undefined, duration)
  }
  const handleJoinAsStudent = () => {
    if (!name.trim()) return alert('Please enter your name')
    localStorage.setItem('lp_name', name.trim())
    setRole('student'); join(pollId, 'student', name.trim())
  }

  const retryJoin = () => {
    if (!name.trim()) return alert('Please enter your name')
    join(pollId, 'student', name.trim())
   socket.emit('get_state', { pollId }) 
  }

  const askQuestion = () => {
    const q = question.trim()
    const opts = options.map(o => o.trim()).filter(Boolean)
    if (!q || opts.length < 2) return alert('Enter question and at least two options')
    // Send to server
    socket.emit('ask_question', { pollId, question: q, options: opts, durationSec: Number(duration) })
    // Optimistic UI so teacher sees it immediately
    setPartial(null)
    setState(s => ({
      ...s,
      question: q,
      options: opts,
      active: true,
      durationSec: Number(duration) || 60,
      startedAt: Date.now(),
      results: Array(opts.length).fill(0)
    }))
  }

  const submitAnswer = (i) => {
    socket.emit('submit_answer', { pollId, optionIndex: i, name })
  }

  const removeStudent = (id) => socket.emit('remove_student', { pollId, studentSocketId: id })
  const loadHistory = () => socket.emit('get_history', { pollId })

  // re-render the countdown every 1s when active
  useEffect(() => {
    if (!state.active) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [state.active])

  const timeLeft = (() => {
    if (!state.active || !state.startedAt) return 0
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000)
    return Math.max(0, (state.durationSec || 60) - elapsed)
  })()

  return (
    <div className="container">
      {!role && (
        <div className="card center">
          <h2>Which type of user are you?</h2>
          <div className="row gap">
            <button onClick={handleJoinAsStudent}>I am Student</button>
            <button className="primary" onClick={handleJoinAsTeacher}>I am Teacher</button>
          </div>
          <div className="row gap top">
            <input name="pollId" id="pollId" value={pollId} onChange={e=>setPollId(e.target.value)} placeholder="Poll ID (share with class)" />
          </div>
          <div className="row gap top">
            <input name="studentName" id="studentName" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name (student)" />
            <input name="duration" id="duration" type="number" value={duration} onChange={e=>setDuration(e.target.value)} placeholder="Duration (sec)" />
          </div>
        </div>
      )}

      {role==='teacher' && (
        <div className="layout">
          <div className="card">
            <h3>Enter question and options</h3>
            <div className="pill" style={{ marginBottom: '1rem' }}>
  {students.length} student{students.length !== 1 ? 's' : ''} online
</div>
            <input name="question" id="question" value={question} onChange={e=>setQuestion(e.target.value)} placeholder="Question" />
            {options.map((o,i)=> (
              <input name={`option-${i}`} id={`option-${i}`} key={i} value={o} onChange={e=>setOptions(prev=>prev.map((x,idx)=>idx===i?e.target.value:x))} placeholder={`Option ${i+1}`} />
            ))}
            <div className="row gap">
              <button onClick={()=>setOptions(prev=>[...prev,''])}>Add another option</button>
              <input name="durationTeacher" id="durationTeacher" type="number" value={duration} onChange={e=>setDuration(e.target.value)} />
              <button className="primary" onClick={askQuestion}>Ask question</button>
            </div>
          </div>

          <div className="card">
            <h3>Live Results {state.active?`(time left: ${timeLeft}s)`:''}</h3>
            <div className="muted">{state.question || 'No question yet'}</div>
            <Results options={state.options} results={(partial?.results)||state.results} />
            <div className="row top">
              <button onClick={loadHistory}>Get earlier results</button>
            </div>
            {students?.length>0 && (
              <div className="top">
                <h4>Students</h4>
                <ul className="list">
                  {students.map((s,i)=> (
                    <li key={i} className="row between">
                      <span>{s.name || s}</span>
                      <button onClick={()=>removeStudent(s.id)} className="danger">Remove</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {history?.length>0 && (
              <div className="top">
                <h4>Past Polls</h4>
                <ul className="list">
                  {history.map((h,i)=> (
                    <li key={i}>
                      <div className="muted">{new Date(h.askedAt).toLocaleString()} • {h.durationSec}s</div>
                      <div><b>{h.question}</b></div>
                      <Results options={h.options} results={h.results} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

     {role==='student' && (
  <div className="layout">
    {state.active && state.question ? (
      <div className="card">
        <div className="row between"><h3>Select answer and submit</h3><div className="pill">{timeLeft}s</div>
        <div className="pill" style={{ marginTop: '0.5rem' }}>
  {students.length} student{students.length !== 1 ? 's' : ''} online
</div></div>
        <div className="question">{state.question}</div>
        <div className="options">
          {state.options.map((o,i)=> (
            <button key={i} onClick={()=>submitAnswer(i)} className="option">{o}</button>
          ))}
        </div>
      </div>
    ) : !state.question ? (
      <div className="card center">
        <div>Waiting for teacher to ask question…</div>
        <div className="row gap top">
          <button onClick={retryJoin}>Retry sync</button>
        </div>
      </div>
    ) : (
      <div className="card">
        <h3>Polling results</h3>
        <Results options={state.options} results={state.results} />
      </div>
    )}
  </div>
)}
    </div>
  )
}


