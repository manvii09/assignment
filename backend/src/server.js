import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// In-memory store (reset on server restart)
const polls = new Map(); // pollId -> { teacherId, question, options, answers, startedAt, durationSec, closed }

function createPoll(pollId, teacherId) {
  const poll = {
    teacherId,
    question: null,
    options: [],
    answers: new Map(), // socketId -> { name, optionIndex, at }
    startedAt: null,
    durationSec: 60,
    closed: false,
    students: new Map(), // socketId -> name
    history: [], // { question, options, results, askedAt, durationSec }
  };
  polls.set(pollId, poll);
  return poll;
}

function getResults(poll) {
  const counts = Array(poll.options.length).fill(0);
  for (const { optionIndex } of poll.answers.values()) {
    if (typeof optionIndex === "number" && optionIndex >= 0 && optionIndex < counts.length) {
      counts[optionIndex] += 1;
    }
  }
  return counts;
}

function isQuestionActive(poll) {
  if (!poll.question || poll.closed) return false;
  if (!poll.startedAt) return false;
  const elapsed = (Date.now() - poll.startedAt) / 1000;
  return elapsed < poll.durationSec;
}

io.on("connection", (socket) => {
  // Clients join a room by pollId
  socket.on("join_poll", ({ pollId, role, name, durationSec }) => {
    if (!pollId) return;
    let poll = polls.get(pollId);
    if (!poll) {
      if (role === "teacher") {
        poll = createPoll(pollId, socket.id);
        if (durationSec && Number(durationSec) > 0) poll.durationSec = Number(durationSec);
      } else {
        socket.emit("error_message", "Poll not found yet. Ask teacher to create it.");
        return;
      }
    }

    socket.join(pollId);

    if (role === "student") {
      const uniqueName = name || `Student-${socket.id.slice(0, 4)}`;
      poll.students.set(socket.id, uniqueName);
      socket.emit("joined", { pollId, role, name: uniqueName });
      io.to(pollId).emit("students_update", Array.from(poll.students.values()));
      // Send current state
      socket.emit("poll_state", {
        question: poll.question,
        options: poll.options,
        results: getResults(poll),
        active: isQuestionActive(poll),
        durationSec: poll.durationSec,
        startedAt: poll.startedAt,
        closed: poll.closed,
      });
    }

    if (role === "teacher") {
      poll.teacherId = socket.id;
      socket.emit("joined", { pollId, role: "teacher" });
      socket.emit("poll_state", {
        question: poll.question,
        options: poll.options,
        results: getResults(poll),
        active: isQuestionActive(poll),
        durationSec: poll.durationSec,
        startedAt: poll.startedAt,
        closed: poll.closed,
        students: Array.from(poll.students.entries()).map(([id, nm]) => ({ id, name: nm })),
        history: poll.history,
      });
    }
  });

  // Teacher asks a question
  socket.on("ask_question", ({ pollId, question, options, durationSec }) => {
     console.log(`Question asked for poll ${pollId}: ${question} [${options}]`);
    const poll = polls.get(pollId);
    if (!poll || poll.teacherId !== socket.id) return;

    // Only if none asked yet or all answered
    const allStudents = poll.students.size;
    const allAnswered = poll.answers.size === allStudents && allStudents > 0;
    const canAsk = !poll.question || allAnswered || poll.closed || !isQuestionActive(poll);
    if (!canAsk) {
      socket.emit("error_message", "Cannot ask a new question yet. Wait for all answers or timeout.");
      return;
    }

    poll.question = String(question || "").trim();
    poll.options = Array.isArray(options) ? options.filter(Boolean) : [];
    poll.answers.clear();
    poll.closed = false;
    if (durationSec && Number(durationSec) > 0) poll.durationSec = Number(durationSec);
    poll.startedAt = Date.now();

    io.to(pollId).emit("new_question", {
      question: poll.question,
      options: poll.options,
      durationSec: poll.durationSec,
      startedAt: poll.startedAt,
    });

    // Auto-close after duration
    setTimeout(() => {
      const current = polls.get(pollId);
      if (!current || current.closed || !current.question) return;
      current.closed = true;
      const results = getResults(current);
      io.to(pollId).emit("results", { results, question: current.question, options: current.options });
      current.history.push({
        question: current.question,
        options: current.options.slice(),
        results,
        askedAt: current.startedAt,
        durationSec: current.durationSec,
      });
    }, poll.durationSec * 1000 + 50);
  });

  // Student submits answer
  socket.on("submit_answer", ({ pollId, optionIndex, name }) => {
    const poll = polls.get(pollId);
    if (!poll || !isQuestionActive(poll)) return;
    const displayName = name || poll.students.get(socket.id) || `Student-${socket.id.slice(0, 4)}`;
    poll.students.set(socket.id, displayName);
    poll.answers.set(socket.id, { name: displayName, optionIndex, at: Date.now() });

    const results = getResults(poll);
    io.to(pollId).emit("partial_results", { results, total: poll.answers.size });

    // If all students answered, close early and show results
    if (poll.answers.size === poll.students.size && poll.students.size > 0) {
      poll.closed = true;
      io.to(pollId).emit("results", { results, question: poll.question, options: poll.options });
      poll.history.push({
        question: poll.question,
        options: poll.options.slice(),
        results,
        askedAt: poll.startedAt,
        durationSec: poll.durationSec,
      });
    }
  });

  // Teacher removes a student
  socket.on("remove_student", ({ pollId, studentSocketId }) => {
    const poll = polls.get(pollId);
    if (!poll || poll.teacherId !== socket.id) return;
    poll.students.delete(studentSocketId);
    poll.answers.delete(studentSocketId);
    io.to(pollId).emit("students_update", Array.from(poll.students.values()));
  });

  // Teacher requests history
  socket.on("get_history", ({ pollId }) => {
    const poll = polls.get(pollId);
    if (!poll || poll.teacherId !== socket.id) return;
    socket.emit("history", poll.history);
  });

  // Any client can request current poll state
  socket.on("get_state", ({ pollId }) => {
    const poll = polls.get(pollId);
    if (!poll) return;
    socket.emit("poll_state", {
      question: poll.question,
      options: poll.options,
      results: getResults(poll),
      active: isQuestionActive(poll),
      durationSec: poll.durationSec,
      startedAt: poll.startedAt,
      closed: poll.closed,
    });
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      const poll = polls.get(room);
      if (!poll) continue;
      poll.students.delete(socket.id);
      poll.answers.delete(socket.id);
      io.to(room).emit("students_update", Array.from(poll.students.values()));
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});


