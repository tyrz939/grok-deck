"""Runs worker tasks in threads, reports their status, and restarts workers that stall."""
import threading
import time


class Worker:
    def __init__(self, name, task):
        self.name = name
        self.task = task  # callable(worker); calls worker.emit(line) as it makes progress
        self.output = []
        self.restarts = 0
        self.last_activity = time.monotonic()
        self._stop = threading.Event()
        self._thread = None

    def touch(self):
        self.last_activity = time.monotonic()

    def emit(self, line):
        self.output.append(line)
        self.touch()

    def report(self):
        """Called by StatusReporter on every tick."""
        self.touch()
        return "%s: %d lines" % (self.name, len(self.output))

    @property
    def stopping(self):
        return self._stop.is_set()

    def start(self):
        self._stop = threading.Event()
        self.touch()
        self._thread = threading.Thread(target=self.task, args=(self,), daemon=True)
        self._thread.start()

    def restart(self):
        self._stop.set()
        self.restarts += 1
        self.start()


class StatusReporter(threading.Thread):
    def __init__(self, workers, every=0.1):
        super().__init__(daemon=True)
        self.workers = workers
        self.every = every
        self.lines = []
        self.running = True

    def run(self):
        while self.running:
            self.lines = [w.report() for w in self.workers]
            time.sleep(self.every)


class Supervisor:
    def __init__(self, workers, stall_after, log_path="supervisor.log"):
        self.workers = workers
        self.stall_after = stall_after
        self.log_path = log_path

    def check_stalls(self):
        pass

    def run(self, seconds, tick=0.05):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.check_stalls()
            time.sleep(tick)


def main():
    def busy(worker):
        while not worker.stopping:
            worker.emit("tick")
            time.sleep(0.2)

    workers = [Worker("ingest", busy), Worker("index", busy)]
    for w in workers:
        w.start()
    StatusReporter(workers).start()  # always on in production
    Supervisor(workers, stall_after=5).run(60)


if __name__ == "__main__":
    main()
