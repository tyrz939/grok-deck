import time
from supervisor import Supervisor, Worker


def test_healthy_worker_not_restarted():
    def busy(w):
        while not w.stopping:
            w.emit("x")
            time.sleep(0.05)
    w = Worker("ok", busy)
    w.start()
    Supervisor([w], stall_after=0.5).run(1.0)
    assert w.restarts == 0
