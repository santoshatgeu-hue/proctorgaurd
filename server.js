const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/proctor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'proctor.html')));

// In-memory store
const sessions = new Map();
const violations = [];

io.on('connection', (socket) => {

  // STUDENT joins
  socket.on('student:join', ({ studentId, examId, name, roll }) => {
    sessions.set(studentId, { socketId: socket.id, examId, name, roll, progress: 0, violations: 0, status: 'active' });
    socket.join(`exam:${examId}`);
    io.to(`proctors:${examId}`).emit('student:online', { studentId, name, roll, progress: 0, violations: 0, status: 'active' });
    console.log(`✅ Student joined: ${name} (${roll})`);
  });

  // PROCTOR joins
  socket.on('proctor:join', ({ examId }) => {
    socket.join(`proctors:${examId}`);
    const snapshot = [];
    sessions.forEach((data, studentId) => {
      if (data.examId === examId) snapshot.push({ studentId, ...data });
    });
    socket.emit('sessions:snapshot', snapshot);
    console.log(`🛡 Proctor joined exam: ${examId}`);
  });

  // WebRTC: proctor requests stream from a student
  socket.on('webrtc:request', ({ studentId }) => {
    const session = sessions.get(studentId);
    if (session) {
      io.to(session.socketId).emit('webrtc:request', { proctorSocketId: socket.id });
      console.log(`📹 Proctor requesting video from ${studentId}`);
    }
  });

  // WebRTC: student sends offer to proctor
  socket.on('webrtc:offer', ({ proctorSocketId, offer, studentId }) => {
    io.to(proctorSocketId).emit('webrtc:offer', { offer, studentId, studentSocketId: socket.id });
  });

  // WebRTC: proctor sends answer back to student
  socket.on('webrtc:answer', ({ studentSocketId, answer }) => {
    io.to(studentSocketId).emit('webrtc:answer', { answer });
  });

  // WebRTC: ICE candidate relay (both directions)
  socket.on('webrtc:ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc:ice', { candidate, fromSocketId: socket.id });
  });

  // VIOLATION reported
  socket.on('violation:report', ({ studentId, examId, type, severity, studentName }) => {
    const entry = { studentId, studentName, type, severity, ts: new Date().toISOString() };
    violations.push(entry);
    if (sessions.has(studentId)) {
      sessions.get(studentId).violations++;
      if (sessions.get(studentId).violations >= 5) sessions.get(studentId).status = 'flagged';
      else if (sessions.get(studentId).violations >= 2) sessions.get(studentId).status = 'warn';
    }
    io.to(`proctors:${examId}`).emit('violation:new', {
      ...entry,
      totalViolations: sessions.get(studentId)?.violations || 0,
      studentStatus: sessions.get(studentId)?.status || 'active'
    });
  });

  // ANSWER saved
  socket.on('answer:save', ({ studentId, questionId, answer }) => {
    if (sessions.has(studentId)) {
      const s = sessions.get(studentId);
      s.answers = s.answers || {};
      s.answers[questionId] = answer;
    }
  });

  // PROGRESS update
  socket.on('progress:update', ({ studentId, examId, progress }) => {
    if (sessions.has(studentId)) sessions.get(studentId).progress = progress;
    io.to(`proctors:${examId}`).emit('student:progress', { studentId, progress });
  });

  // EXAM submitted
  socket.on('exam:submit', ({ studentId, examId }) => {
    if (sessions.has(studentId)) sessions.get(studentId).status = 'submitted';
    io.to(`proctors:${examId}`).emit('student:submitted', { studentId });
    console.log(`📤 Exam submitted: ${studentId}`);
  });

  // PROCTOR warns student
  socket.on('proctor:warn', ({ studentId, message }) => {
    const session = sessions.get(studentId);
    if (session) io.to(session.socketId).emit('warning:received', { message });
  });

  // PROCTOR terminates student
  socket.on('proctor:terminate', ({ studentId, examId }) => {
    const session = sessions.get(studentId);
    if (session) {
      session.status = 'terminated';
      io.to(session.socketId).emit('exam:terminated', {});
      io.to(`proctors:${examId}`).emit('student:terminated', { studentId });
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    sessions.forEach((data, studentId) => {
      if (data.socketId === socket.id) {
        data.status = 'offline';
        io.to(`proctors:${data.examId}`).emit('student:offline', { studentId });
        console.log(`❌ Student disconnected: ${data.name}`);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎓 ProctorGuard running on port ${PORT}`);
  console.log(`   Student URL: http://localhost:${PORT}/student`);
  console.log(`   Proctor URL: http://localhost:${PORT}/proctor\n`);
});
