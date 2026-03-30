# 04 — Correctness and Efficiency

## Document Information

| Field | Value |
|-------|-------|
| **Document ID** | 04 |
| **Title** | Correctness and Efficiency |
| **Category** | Risk Register / Correctness Assessment |
| **Finding Prefix** | `CORRECT-XXX` |
| **Scope** | All non-generated, non-vendor Go source in `pkg/`, `cmd/`, `plugin/`, `staging/src/k8s.io/` |
| **Analysis Type** | Static code inspection only — no runtime profiling or benchmarking |
| **Inference Convention** | `CONFIRMED` = directly observed in source; `INFERRED` = conclusion drawn from absence or pattern |

---

## Table of Contents

- [1. Redundant Logic Inventory](#1-redundant-logic-inventory)
  - [1.1 Redundant Controller Boilerplate](#11-redundant-controller-boilerplate)
  - [1.2 Redundant Informer Event Handler Wiring](#12-redundant-informer-event-handler-wiring)
  - [1.3 Redundant Tombstone Unwrapping](#13-redundant-tombstone-unwrapping)
  - [1.4 Redundant ControllerRef Resolution](#14-redundant-controllerref-resolution)
  - [1.5 Redundant Retry / Backoff Constants](#15-redundant-retry--backoff-constants)
  - [1.6 Redundant Proxy State-Tracking Structures](#16-redundant-proxy-state-tracking-structures)
  - [1.7 Redundant Worker-Loop Pattern](#17-redundant-worker-loop-pattern)
  - [1.8 Redundant Error-Handling in processNextWorkItem](#18-redundant-error-handling-in-processnextworkitem)
- [2. Language Feature Misuse Catalog](#2-language-feature-misuse-catalog)
  - [2.1 Goroutine Lifecycle Issues](#21-goroutine-lifecycle-issues)
  - [2.2 Channel Misuse](#22-channel-misuse)
  - [2.3 Context Propagation Failures](#23-context-propagation-failures)
  - [2.4 Unhandled Error Returns](#24-unhandled-error-returns)
  - [2.5 Improper Async Handling](#25-improper-async-handling)
- [3. Correctness Risk Register](#3-correctness-risk-register)
- [4. Fragile Logic Inventory](#4-fragile-logic-inventory)
- [5. Summary Statistics](#5-summary-statistics)

---

## 1. Redundant Logic Inventory

This section catalogs instances where logically identical or near-identical code is independently implemented in multiple locations, creating divergence risk and maintenance overhead.

---

### 1.1 Redundant Controller Boilerplate

#### **CORRECT-001**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-001 |
| **Category** | Redundant Logic |
| **Title** | Identical controller struct and constructor boilerplate across 36+ controllers |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:68-130`, `pkg/controller/job/job_controller.go:95-170`, `pkg/controller/daemon/daemon_controller.go:85-145`, `pkg/controller/replicaset/replica_set.go:68-130`, `pkg/controller/garbagecollector/garbagecollector.go:60-110` |
| **Description** | Every controller in `pkg/controller/*/` independently implements an identical structural pattern: a struct containing a `client` field, informer listers, `*Synced` cache sync booleans, a `workqueue.TypedRateLimitingInterface[string]`, an injectable `syncHandler func(ctx, key string) error`, and an event broadcaster. The `NewXXXController()` constructor in each controller follows the same template — create an event broadcaster, create a rate-limited workqueue, register informer event handlers (`AddFunc`/`UpdateFunc`/`DeleteFunc` with logger extraction), assign listers, and assign the `syncHandler`. This boilerplate is duplicated independently across all 36 controller packages with no shared base abstraction. |
| **Evidence** | In `deployment_controller.go`, the struct definition (lines 68–100) contains `client`, `rsLister`, `rsListerSynced`, `podLister`, `podListerSynced`, `dLister`, `dListerSynced`, `queue`, `syncHandler`, and `eventBroadcaster`. In `job_controller.go`, the struct (lines 95–155) contains nearly identical fields: `kubeClient`, `podStore`, `podStoreSynced`, `jobLister`, `jobStoreSynced`, `queue`, `syncHandler`, `eventBroadcaster`. The same structural pattern repeats in every controller in the directory. |
| **Impact** | When a cross-cutting change is needed (e.g., adding structured logging, changing workqueue configuration, or updating event broadcaster startup), every controller must be modified independently. This has led to observable divergence — for example, the garbage collector uses `sync.WaitGroup` from the `wait` package via `wg.Go()` while some older controllers may use raw goroutines. The maintenance burden scales linearly with the number of controllers (36+). |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-001] |

---

### 1.2 Redundant Informer Event Handler Wiring

#### **CORRECT-002**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-002 |
| **Category** | Redundant Logic |
| **Title** | Copy-pasted informer event handler wiring in every controller constructor |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:131-200`, `pkg/controller/job/job_controller.go:180-250`, `pkg/controller/daemon/daemon_controller.go:150-220`, `pkg/controller/replicaset/replica_set.go:135-230` |
| **Description** | Each controller independently registers `AddFunc`, `UpdateFunc`, and `DeleteFunc` handlers on informers. The handler bodies follow the same pattern: extract a logger from the context, cast the object to the expected type, perform optional filtering, then enqueue the owning resource. This wiring logic is not shared; each controller reimplements it from scratch. |
| **Evidence** | In the deployment controller constructor (lines 131–200), `dInformer.Informer().AddEventHandler` registers `AddFunc`, `UpdateFunc`, and `DeleteFunc` lambdas that extract a logger via `klog.FromContext(ctx)` and call enqueue methods. The job controller (lines 180–250) does the same for jobs, pods, and the job informer. The daemon set controller (lines 150–220) follows an identical registration pattern for DaemonSet, ControllerRevision, and Pod informers. |
| **Impact** | Subtle divergence in event handler logic can lead to different controllers behaving inconsistently when objects change. For example, one controller might check for deletion timestamps in `UpdateFunc` while another does not, creating inconsistent orphan handling. Any improvement to event handler ergonomics must be applied to all 36+ controllers independently. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-002] |

---

### 1.3 Redundant Tombstone Unwrapping

#### **CORRECT-003**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-003 |
| **Category** | Redundant Logic |
| **Title** | Identical `cache.DeletedFinalStateUnknown` tombstone unwrapping logic in every delete handler |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:245-268`, `pkg/controller/job/job_controller.go:290-310`, `pkg/controller/daemon/daemon_controller.go:210-235`, `pkg/controller/replicaset/replica_set.go:200-225` |
| **Description** | Every controller's `DeleteFunc` handler contains the same tombstone unwrapping pattern: attempt to type-assert the object to the expected type; if that fails, check whether it is a `cache.DeletedFinalStateUnknown` and unwrap the enclosed object; if the unwrapped object is still not the expected type, call `utilruntime.HandleError` and return. This 10–15 line block is repeated in every delete handler across all controllers. |
| **Evidence** | In the deployment controller's `deleteDeployment` handler (lines 245–268): ```go tombstone, ok := obj.(cache.DeletedFinalStateUnknown) if !ok { utilruntime.HandleError(fmt.Errorf("...")) return } d, ok = tombstone.Obj.(*apps.Deployment) if !ok { utilruntime.HandleError(fmt.Errorf("...")) return } ``` The job controller's `deleteJob` (lines 290–310) contains the exact same structure, differing only in the target type. |
| **Impact** | The redundancy is a maintenance burden — 36+ identical blocks that must be kept in sync. More critically, if a bug is introduced in the tombstone handling logic in one controller (e.g., missing the `DeletedFinalStateUnknown` check), it silently drops events, and the fix must be propagated to all controllers manually. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-003] |

---

### 1.4 Redundant ControllerRef Resolution

#### **CORRECT-004**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-004 |
| **Category** | Redundant Logic |
| **Title** | Identical `resolveControllerRef` method duplicated across controllers |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:468-484`, `pkg/controller/job/job_controller.go:300-316`, `pkg/controller/replicaset/replica_set.go` (equivalent pattern) |
| **Description** | Multiple controllers implement a `resolveControllerRef` method with identical logic: look up the owner by `Name` in the lister, verify that the `UID` matches the `ControllerRef.UID`, and return `nil` on mismatch. The method also performs a `Kind` check against the controller's own `controllerKind` variable before the lookup. This logic is semantically identical across deployment, job, and replica set controllers. |
| **Evidence** | Deployment controller (lines 468–484): ```go func (dc *DeploymentController) resolveControllerRef(namespace string, controllerRef *metav1.OwnerReference) *apps.Deployment { if controllerRef.Kind != controllerKind.Kind { return nil } d, err := dc.dLister.Deployments(namespace).Get(controllerRef.Name) if err != nil { return nil } if d.UID != controllerRef.UID { return nil } return d } ``` The job controller has the same method at lines 300–316 returning `*batch.Job` instead. |
| **Impact** | Divergence risk is moderate: if one controller adds additional validation (e.g., checking for `DeletionTimestamp`), others may not receive the same improvement. The lookup-error-on-`Name`-then-verify-`UID` pattern silently returns `nil` on errors, which means transient API server errors are indistinguishable from legitimate "owner not found" cases. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-004] |

---

### 1.5 Redundant Retry / Backoff Constants

#### **CORRECT-005**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-005 |
| **Category** | Redundant Logic |
| **Title** | Independently defined retry limits and backoff constants across controllers |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:62` (`maxRetries = 15`), `pkg/controller/daemon/daemon_controller.go:65` (`BurstReplicas = 250`, `StatusUpdateRetries = 1`), `pkg/controller/replicaset/replica_set.go:60-62` (`BurstReplicas = 500`, `statusUpdateRetries = 1`), `pkg/controller/job/job_controller.go:60-65` (`MaxUncountedPods = 500`, `MaxPodCreateDeletePerSync = 500`) |
| **Description** | Each controller defines its own set of retry limits, burst limits, and backoff configurations as package-level constants. There is no shared configuration or central constant registry for these cross-cutting values. The `maxRetries` constant is defined independently in each controller — deployment uses 15, while other controllers define their own values. The `BurstReplicas` constant differs between daemon set (250) and replica set (500) without documented justification for the discrepancy. |
| **Evidence** | Deployment controller line 62: `const maxRetries = 15`. DaemonSet controller line 65: `const BurstReplicas = 250`. ReplicaSet controller line 60: `const BurstReplicas = 500`. The 2:1 ratio between ReplicaSet and DaemonSet burst limits is not explained in comments. |
| **Impact** | The independent definition of these constants makes it difficult to maintain a consistent retry/backoff policy across the control plane. A cluster-wide change to retry behavior requires searching for and modifying constants in every controller package. The undocumented discrepancy between `BurstReplicas` values (250 vs 500) creates confusion about whether this is intentional tuning or historical divergence. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-005] |

---

### 1.6 Redundant Proxy State-Tracking Structures

#### **CORRECT-006**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-006 |
| **Category** | Redundant Logic |
| **Title** | Structurally identical proxy `Proxier` structs across iptables, IPVS, and nftables modes |
| **Source Location** | `pkg/proxy/iptables/proxier.go:75-200`, `pkg/proxy/ipvs/proxier.go:162-200` |
| **Description** | The `Proxier` struct in each proxy mode (iptables, IPVS, nftables) contains a nearly identical set of fields: `endpointsChanges *proxy.EndpointsChangeTracker`, `serviceChanges *proxy.ServiceChangeTracker`, `mu sync.Mutex`, `svcPortMap proxy.ServicePortMap`, `endpointsMap proxy.EndpointsMap`, sync status booleans (`endpointSlicesSynced`, `servicesSynced`), an `initialized` atomic, and a `syncRunner *runner.BoundedFrequencyRunner`. Each mode defines these fields independently rather than embedding a shared base struct. |
| **Evidence** | iptables `Proxier` struct (lines 75–200) defines `endpointsChanges`, `serviceChanges`, `mu sync.Mutex`, `svcPortMap`, `endpointsMap`, `endpointSlicesSynced`, `servicesSynced`, `initialized int32`, `syncRunner *runner.BoundedFrequencyRunner`. IPVS `Proxier` struct (lines 162–200) defines the same fields: `endpointsChanges`, `serviceChanges`, `mu sync.Mutex`, `svcPortMap`, `endpointsMap`, `endpointSlicesSynced`, `servicesSynced`, `initialized int32`, `syncRunner *runner.BoundedFrequencyRunner`. |
| **Impact** | When the proxy infrastructure adds a new shared field (e.g., topology awareness, dual-stack metadata), every proxy mode must be updated independently. The parallel structures also create a risk that one mode evolves its synchronization logic (e.g., granularity of mutex usage) while others lag behind, leading to subtle behavioral differences. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-006] |

---

### 1.7 Redundant Worker-Loop Pattern

#### **CORRECT-007**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-007 |
| **Category** | Redundant Logic |
| **Title** | Identical `worker` → `processNextWorkItem` → `syncHandler` → `handleErr` call chain in every controller |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:488-526`, `pkg/controller/job/job_controller.go` (equivalent pattern), `pkg/controller/daemon/daemon_controller.go` (equivalent pattern), `pkg/controller/replicaset/replica_set.go` (equivalent pattern) |
| **Description** | Every workqueue-based controller implements the same four-method call chain: `worker(ctx)` calls `processNextWorkItem(ctx)` in a loop; `processNextWorkItem` gets a key from the queue, calls `syncHandler`, then calls `handleErr`; `handleErr` checks `NumRequeues` against `maxRetries` and either requeues with rate limiting or drops the item. This pattern is semantically identical across all controllers but implemented independently in each. |
| **Evidence** | Deployment controller `worker` (line 488): `for dc.processNextWorkItem(ctx) {}`. `processNextWorkItem` (line 493): `key, quit := dc.queue.Get(); ... err := dc.syncHandler(ctx, key); dc.handleErr(ctx, err, key)`. `handleErr` (line 506): checks `dc.queue.NumRequeues(key) < maxRetries`, calls `dc.queue.AddRateLimited(key)` on retry, `dc.queue.Forget(key)` on drop. Every other controller uses this exact structure. |
| **Impact** | Approximately 36 × 4 = 144 methods across the controller codebase implement this identical pattern. Changes to the retry strategy (e.g., structured error classification, exponential backoff at the worker level) require modifying all 36 controllers. Minor divergence already exists — some controllers check for `errors.HasStatusCause(err, v1.NamespaceTerminatingCause)` in `handleErr` while others do not. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-007] |

---

### 1.8 Redundant Error-Handling in processNextWorkItem

#### **CORRECT-008**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-008 |
| **Category** | Redundant Logic |
| **Title** | Inconsistent error-swallowing behavior in `handleErr` across controllers |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:506-526` |
| **Description** | The `handleErr` pattern across controllers handles the "max retries exceeded" case by calling `utilruntime.HandleError(err)` (which logs the error) and then calling `queue.Forget(key)` to permanently drop the item. This means that after `maxRetries` failures, the workqueue item is silently discarded with only a log entry. The deployment controller also checks `errors.HasStatusCause(err, v1.NamespaceTerminatingCause)` and forgives errors with this cause. This additional check is present in some controllers but not others, constituting measurable divergence in the redundant pattern. |
| **Evidence** | Deployment `handleErr` lines 506–526: `if err == nil || errors.HasStatusCause(err, v1.NamespaceTerminatingCause) { dc.queue.Forget(key); return }` followed by `if dc.queue.NumRequeues(key) < maxRetries { ... dc.queue.AddRateLimited(key); return }` and finally `utilruntime.HandleError(err); ... dc.queue.Forget(key)`. |
| **Impact** | Items that persistently fail reconciliation are silently dropped after `maxRetries` (typically 15) attempts. There is no mechanism to surface these "permanently failed" items via metrics, alerts, or a dead-letter queue. The inconsistency in `NamespaceTerminatingCause` handling means different controllers react differently to namespace deletion, which could cause unexpected behavior during namespace cleanup. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-008] |

---

## 2. Language Feature Misuse Catalog

This section catalogs Go-specific language feature misuse patterns observed through static analysis of the codebase. Categories: goroutine lifecycle issues, channel misuse, context propagation failures, unhandled error returns, and improper async handling.

---

### 2.1 Goroutine Lifecycle Issues

#### **CORRECT-009**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-009 |
| **Category** | Goroutine Lifecycle — Missing Cancellation |
| **Title** | Eviction manager monitoring goroutine has no cancellation mechanism |
| **Source Location** | `pkg/kubelet/eviction/eviction_manager.go:209-222` |
| **Description** | The eviction manager's `Start()` method launches a monitoring goroutine with `go func() { for { ... time.Sleep(monitoringInterval) } }()`. This goroutine uses an infinite `for` loop with `time.Sleep` but has no mechanism for cancellation — there is no `select` on `ctx.Done()`, no `stopCh`, and no `break` condition. The goroutine will run until the process exits. |
| **Evidence** | ```go // eviction_manager.go:209-222 go func() { for { evictedPods, err := m.synchronize(ctx, diskInfoProvider, podFunc) if evictedPods != nil && err == nil { logger.Info("Eviction manager: pods evicted, waiting for pod to be cleaned up", "pods", klog.KObjSlice(evictedPods)) m.waitForPodsCleanup(logger, podCleanedUpFunc, evictedPods) } else { if err != nil { logger.Error(err, "Eviction manager: failed to synchronize") } time.Sleep(monitoringInterval) } } }() ``` Note: while `ctx` is passed to `m.synchronize()`, the outer loop itself never checks `ctx.Done()`. If the context is cancelled, `synchronize` may return an error, but the loop continues sleeping and retrying indefinitely. |
| **Impact** | In normal operation this goroutine lives for the lifetime of the kubelet process, so the missing cancellation is not critical. However, it violates the Go pattern of goroutine lifecycle management and makes it impossible to cleanly shut down the eviction monitoring loop during graceful shutdown or tests. The `time.Sleep` is not interruptible by context cancellation, meaning the goroutine takes up to `monitoringInterval` (default 10s) to respond to shutdown. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-009] |

---

#### **CORRECT-010**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-010 |
| **Category** | Goroutine Lifecycle — Inconsistent Patterns |
| **Title** | Garbage collector uses mixed goroutine management patterns for identical worker types |
| **Source Location** | `pkg/controller/garbagecollector/garbagecollector.go:172-179` |
| **Description** | The garbage collector's `Run()` method launches two types of workers — `runAttemptToDeleteWorker` and `runAttemptToOrphanWorker` — using different goroutine management patterns. The delete workers use `wait.UntilWithContext(ctx, ...)` which accepts a context directly. The orphan workers use `wait.Until(func() { gc.runAttemptToOrphanWorker(logger) }, 1*time.Second, ctx.Done())` which converts the context cancellation to a stop channel. These are semantically equivalent but structurally different approaches used side-by-side. |
| **Evidence** | ```go // garbagecollector.go:172-179 for i := 0; i < workers; i++ { wg.Go(func() { wait.UntilWithContext(ctx, gc.runAttemptToDeleteWorker, 1*time.Second) }) wg.Go(func() { wait.Until(func() { gc.runAttemptToOrphanWorker(logger) }, 1*time.Second, ctx.Done()) }) } ``` |
| **Impact** | The inconsistency does not cause a functional bug but creates confusion for maintainers about which pattern is preferred. It suggests that `runAttemptToOrphanWorker` was not updated when the codebase transitioned from stop-channel to context-based cancellation. New contributors may copy either pattern, perpetuating the inconsistency. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-010] |

---

#### **CORRECT-011**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-011 |
| **Category** | Goroutine Lifecycle — Async Binding |
| **Title** | Scheduler binding goroutine launched per pod with no upper bound on concurrency |
| **Source Location** | `pkg/scheduler/schedule_one.go:123-135` |
| **Description** | The `scheduleOne()` function spawns a goroutine for each pod's binding cycle via `go func() { ... sched.bindingCycle(...) ... }()`. While the goroutine properly uses a derived context with cancellation (`bindingCycleCtx, cancel := context.WithCancel(ctx)`) and tracks metrics (`metrics.Goroutines.WithLabelValues(metrics.Binding).Inc()`), there is no concurrency limiter (e.g., semaphore or bounded channel) governing how many binding goroutines can be active simultaneously. Under heavy scheduling load, this could lead to an unbounded number of concurrent binding goroutines. |
| **Evidence** | ```go // schedule_one.go:123-135 go func() { bindingCycleCtx, cancel := context.WithCancel(ctx) defer cancel() metrics.Goroutines.WithLabelValues(metrics.Binding).Inc() defer metrics.Goroutines.WithLabelValues(metrics.Binding).Dec() status := sched.bindingCycle(bindingCycleCtx, state, fwk, scheduleResult, assumedPodInfo, start, podsToActivate) if !status.IsSuccess() { sched.handleBindingCycleError(bindingCycleCtx, state, fwk, assumedPodInfo, start, scheduleResult, status) return } }() ``` |
| **Impact** | In large clusters with thousands of pods being scheduled simultaneously, the unbounded goroutine creation could cause memory pressure and API server overload from concurrent bind requests. The metric tracking (`Goroutines` gauge) provides observability but not admission control. The natural serialization of the scheduling cycle (one pod at a time before the binding goroutine is spawned) provides implicit rate limiting, but during catch-up scenarios (e.g., after scheduler restart), many binding goroutines could accumulate. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-011] |

---

#### **CORRECT-012**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-012 |
| **Category** | Goroutine Lifecycle — Panic as Control Flow |
| **Title** | `panic()` used as control flow in PLEG state conversion functions |
| **Source Location** | `pkg/kubelet/pleg/generic.go:105-119`, `pkg/kubelet/pleg/generic.go:194-218` |
| **Description** | Two functions in the GenericPLEG — `convertState()` and `generateEvents()` — use `panic()` in their `default` switch cases for unrecognized container states. While these panics are guarded by the upstream `defer utilruntime.HandleCrash()` in the goroutine entry point (`wait.Until` wrapper), using `panic` for state validation means that an unexpected container runtime state will crash the PLEG goroutine, which must then be restarted. This is a risky pattern in a long-running system component. |
| **Evidence** | ```go // generic.go:117 default: panic(fmt.Sprintf("unrecognized container state: %v", state)) ``` ```go // generic.go:216 default: panic(fmt.Sprintf("unrecognized container state: %v", newState)) ``` |
| **Impact** | If a new container state is added to the container runtime interface but the PLEG is not updated, the panic will crash the PLEG relist goroutine. With `HandleCrash` in the call stack, the goroutine will be restarted by the `wait.Until` loop, but this causes a momentary disruption to pod lifecycle event delivery, potentially delaying pod status updates. The panic-and-restart cycle will repeat on every relist iteration until the PLEG code is updated, creating sustained degradation. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-012] |

---

### 2.2 Channel Misuse

#### **CORRECT-013**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-013 |
| **Category** | Channel Misuse — Unbounded Event Channel Risk |
| **Title** | PLEG event channel has fixed capacity of 1000 with no back-pressure mechanism |
| **Source Location** | `pkg/kubelet/kubelet.go:202` (channel creation), `pkg/kubelet/pleg/generic.go:150-152` (channel consumption) |
| **Description** | The PLEG event channel is created with a fixed buffer capacity of 1000 (`plegChannelCapacity = 1000`). The `GenericPLEG.Watch()` method returns this channel directly for consumers to read. If the consumer (kubelet sync loop) falls behind and the channel buffer fills, the PLEG `Relist()` method will block when attempting to send events, effectively stalling the entire PLEG relisting goroutine. There is no back-pressure signaling or event dropping mechanism. |
| **Evidence** | Channel creation in kubelet.go (line 202): `plegChannelCapacity = 1000`. Channel returned directly from `Watch()` in generic.go (line 150–152): ```go func (g *GenericPLEG) Watch() chan *PodLifecycleEvent { return g.eventChannel } ``` |
| **Impact** | Under heavy pod churn (>1000 events between relist cycles), the PLEG goroutine will block, causing the `Healthy()` check to fail (relist time exceeds `RelistThreshold` of 3 minutes), which in turn causes the kubelet to report the node as unhealthy. The fixed buffer size is not dynamically tunable. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-013] |

---

#### **CORRECT-014**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-014 |
| **Category** | Channel Misuse — Timer Leak Prevention |
| **Title** | Reflector resync channel uses explicit timer cleanup to prevent goroutine leaks |
| **Source Location** | `staging/src/k8s.io/client-go/tools/cache/reflector.go:384-395` |
| **Description** | The `Reflector.resyncChan()` method creates a timer and returns both the timer channel and a cleanup function. The comment (lines 389–392) explicitly documents the timer leak risk: "imagine the scenario where watches always fail so we end up listing frequently. Then, if we don't manually stop the timer, we could end up with many timers active concurrently." This is a well-handled pattern, documented here as a positive example and a contrast to other code that does not manage timer lifecycles. |
| **Evidence** | ```go // reflector.go:384-395 func (r *Reflector) resyncChan() (<-chan time.Time, func() bool) { if r.resyncPeriod == 0 { return nil, func() bool { return false } } t := r.clock.NewTimer(r.resyncPeriod) return t.C(), t.Stop } ``` |
| **Impact** | This is a correctly implemented pattern. However, the explicit need for manual timer cleanup highlights the general risk of timer and ticker leaks in long-running Go programs. The pattern is not consistently applied across the codebase — other components use `time.After` or `time.NewTimer` without cleanup. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-014] |

---

### 2.3 Context Propagation Failures

#### **CORRECT-015**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-015 |
| **Category** | Context Propagation — `context.Background()` in PLEG Relist |
| **Title** | GenericPLEG `Relist()` creates `context.Background()` instead of propagating context from `Start()` |
| **Source Location** | `pkg/kubelet/pleg/generic.go:238` |
| **Description** | The `GenericPLEG.Start()` method launches the `Relist` function via `go wait.Until(g.Relist, ...)`. Inside `Relist()`, a fresh `context.Background()` is created on line 238. This means that the context used for container runtime calls within `Relist` is completely disconnected from the `stopCh` used by the `wait.Until` wrapper. If the stop channel is closed, `Relist` will not receive a cancellation signal through its context — it relies solely on `wait.Until` not calling `Relist` again after stop. |
| **Evidence** | ```go // generic.go:234-238 func (g *GenericPLEG) Relist() { g.relistLock.Lock() defer g.relistLock.Unlock() ctx := context.Background() ``` The `Start()` method at line 161: `go wait.Until(g.Relist, g.relistDuration.RelistPeriod, g.stopCh)` — note that `Relist` takes no arguments and cannot receive a context. |
| **Impact** | A currently executing `Relist()` call cannot be cancelled by closing `stopCh`. If the container runtime is slow or unresponsive, `Relist` will block until the runtime call times out, regardless of whether the kubelet has initiated shutdown. This extends the graceful shutdown time by up to the runtime timeout duration. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-015] |

---

#### **CORRECT-016**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-016 |
| **Category** | Context Propagation — `context.Background()` in Eviction Admit |
| **Title** | Eviction manager `Admit()` creates `context.Background()` in admission-path code |
| **Source Location** | `pkg/kubelet/eviction/eviction_manager.go:150-151` |
| **Description** | The `Admit()` method creates a `context.Background()` on line 150 and then extracts a logger from it. The `Admit` method is called in the pod admission path, which has a calling context available. By creating `context.Background()`, the method loses any trace context, timeout, or cancellation signals from the caller. |
| **Evidence** | ```go // eviction_manager.go:150-151 func (m *managerImpl) Admit(attrs *lifecycle.PodAdmitAttributes) lifecycle.PodAdmitResult { m.RLock() defer m.RUnlock() ctx := context.Background() logger := klog.FromContext(ctx) ``` |
| **Impact** | The immediate impact is loss of contextual logging propagation — log entries from `Admit()` will not carry trace IDs or contextual metadata from the caller. The broader pattern concern is that `context.Background()` usage in non-top-level functions prevents future addition of timeouts or cancellation to the admission path. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-016] |

---

#### **CORRECT-017**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-017 |
| **Category** | Context Propagation — `context.TODO()` in Configuration |
| **Title** | `context.TODO()` used in kubelet `makePodSourceConfig` for long-lived operations |
| **Source Location** | `pkg/kubelet/kubelet.go:379` |
| **Description** | The `makePodSourceConfig()` function creates a `context.TODO()` on line 379 and uses it to start pod configuration sources (file watcher, URL fetcher, API server source). These are long-lived operations that run for the lifetime of the kubelet process. The `context.TODO()` carries a comment acknowledging the issue: "it needs to be replaced by a proper context in the future." |
| **Evidence** | ```go // kubelet.go:378-379 // TODO: it needs to be replaced by a proper context in the future ctx := context.TODO() ``` This context is passed to `config.NewSourceFile(logger, ..., cfg.Channel(ctx, ...))`, `config.NewSourceURL(logger, ..., cfg.Channel(ctx, ...))`, and `config.NewSourceApiserver(logger, ..., cfg.Channel(ctx, ...))`. |
| **Impact** | Pod configuration sources started with `context.TODO()` cannot be cancelled by the kubelet shutdown sequence. The acknowledged TODO suggests this is a known technical debt item. The impact is limited because these sources are effectively process-lifetime operations, but the inability to cancel them complicates graceful shutdown and testing. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-017] |

---

#### **CORRECT-018**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-018 |
| **Category** | Context Propagation — `wait.NeverStop` in Kubelet Informer Start |
| **Title** | Kubelet starts shared informer factory with `wait.NeverStop` instead of parent context |
| **Source Location** | `pkg/kubelet/kubelet.go:481` |
| **Description** | In `NewMainKubelet()`, the shared informer factory is started with `kubeInformers.Start(wait.NeverStop)`. The variable `wait.NeverStop` is a channel that is never closed (`var NeverStop <-chan struct{} = make(chan struct{})`). This means the informers started here can never be stopped, even during kubelet graceful shutdown. The `NewMainKubelet` function receives a `ctx context.Context` parameter but does not use it for informer lifecycle management. |
| **Evidence** | ```go // kubelet.go:481 kubeInformers.Start(wait.NeverStop) ``` The parent function signature accepts `ctx context.Context` but this context is not converted to a stop channel for the informer factory. |
| **Impact** | Informers will continue running (consuming API server resources via watch connections) even after the kubelet has initiated graceful shutdown. In testing environments, this prevents clean teardown and can cause resource leaks. The `wait.NeverStop` pattern is used as a convenience but circumvents the context-based lifecycle management that the rest of the codebase is migrating toward. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-018] |

---

### 2.4 Unhandled Error Returns

#### **CORRECT-019**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-019 |
| **Category** | Unhandled Error Returns |
| **Title** | Explicit `//nolint:errcheck` suppression in replica set controller |
| **Source Location** | `pkg/controller/replicaset/replica_set.go:223` |
| **Description** | The replica set controller explicitly suppresses an error check using `//nolint:errcheck` on the call to `controller.AddPodControllerIndexer(podInformer.Informer())`. This function returns an error that could indicate failure to register a cache indexer — a critical initialization step. The error is intentionally discarded. |
| **Evidence** | ```go // replica_set.go:223 controller.AddPodControllerIndexer(podInformer.Informer()) //nolint:errcheck ``` |
| **Impact** | If the indexer registration fails (e.g., duplicate index name), the controller will proceed without the index. Subsequent lookups that rely on this index will return incomplete or empty results, causing the controller to fail to find pods it owns. This would manifest as a silent malfunction where the replica set controller cannot reconcile its pods. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-019] |

---

#### **CORRECT-020**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-020 |
| **Category** | Unhandled Error Returns |
| **Title** | `metrics.Register()` error logged but not propagated in replica set controller |
| **Source Location** | `pkg/controller/replicaset/replica_set.go:143-145` |
| **Description** | The replica set controller's `NewReplicaSetController` calls `metrics.Register()` and if the error is non-nil, logs it with `utilruntime.HandleError()` but continues initialization. Metrics registration failure means the controller's operational metrics will not be available, degrading observability. |
| **Evidence** | ```go // replica_set.go:143-145 if err := metrics.Register(rsInformer.Lister()); err != nil { utilruntime.HandleError(err) } ``` |
| **Impact** | The controller operates without metrics, making it invisible to monitoring systems. In production, this could delay detection of controller malfunctions. The decision to continue without metrics is a deliberate trade-off (availability over observability), but the error should ideally be surfaced more prominently. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-020] |

---

#### **CORRECT-021**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-021 |
| **Category** | Unhandled Error Returns |
| **Title** | Error from `resolveControllerRef` silently returns nil, masking transient API failures |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:468-484` |
| **Description** | The `resolveControllerRef` method calls `dc.dLister.Deployments(namespace).Get(controllerRef.Name)`, and if an error is returned, it simply returns `nil`. The error is not logged, not propagated, and not distinguishable from a legitimate "owner not found" case. If the lister has a transient error (e.g., cache inconsistency), the controller will incorrectly conclude that the owner does not exist and potentially orphan the child resource. |
| **Evidence** | ```go // deployment_controller.go:474-477 d, err := dc.dLister.Deployments(namespace).Get(controllerRef.Name) if err != nil { return nil } ``` |
| **Impact** | Transient lister errors cause the controller to treat owned resources as orphans, triggering incorrect adoption/orphaning logic. This is a correctness risk: a momentary cache miss during informer resync could cause a child resource to be disowned and then re-adopted, creating unnecessary API server churn and potential race conditions with other controllers. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-021] |

---

### 2.5 Improper Async Handling

#### **CORRECT-022**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-022 |
| **Category** | Improper Async — Scheduler Assume-Before-Bind |
| **Title** | Scheduler assumes pod is scheduled before asynchronous bind completes |
| **Source Location** | `pkg/scheduler/schedule_one.go:195-208` |
| **Description** | The scheduling cycle uses an "assume" pattern where the pod is optimistically marked as scheduled in the scheduler's cache (`sched.assume(logger, assumedPod, scheduleResult.SuggestedHost)`) on line 200, and then the actual bind operation happens asynchronously in a separate goroutine (lines 123–135). If the bind fails, the assumed pod must be "forgotten" (`sched.Cache.ForgetPod`). This two-phase approach creates a window where the scheduler's cache state diverges from the API server's state. |
| **Evidence** | ```go // schedule_one.go:200 err = sched.assume(logger, assumedPod, scheduleResult.SuggestedHost) ``` Followed by asynchronous bind in a goroutine: ```go // schedule_one.go:123-135 go func() { status := sched.bindingCycle(bindingCycleCtx, ...) if !status.IsSuccess() { sched.handleBindingCycleError(...) } }() ``` The `handleBindingCycleError` must call `ForgetPod` to clean up the assumption on failure. |
| **Impact** | During the window between assume and bind completion, the scheduler may schedule other pods based on the assumption that the assumed pod is consuming resources on the target node. If the bind fails and `ForgetPod` is delayed, subsequent scheduling decisions may under-provision the target node (treating it as fuller than it actually is) or over-provision it (if `ForgetPod` races with a new scheduling decision). The `durationToExpireAssumedPod` constant is set to `0` (meaning no expiry), so assumed pods persist in cache until explicitly forgotten. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-022] |

---

#### **CORRECT-023**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-023 |
| **Category** | Improper Async — klog.Fatal in Configuration Path |
| **Title** | `klog.Fatalf` used for error handling in control plane configuration, preventing graceful error propagation |
| **Source Location** | `pkg/controlplane/instance.go:229-234`, `pkg/controlplane/instance.go:250-252`, `pkg/controlplane/instance.go:270-271` |
| **Description** | The control plane `Instance` configuration code uses `klog.Fatalf` in multiple locations to handle errors that occur during endpoint reconciler creation and configuration completion. `klog.Fatalf` calls `os.Exit(255)` after logging, which prevents graceful error propagation, deferred cleanup functions, and proper error reporting to the caller. These are initialization-time errors that could be returned to the caller as error values instead. |
| **Evidence** | ```go // instance.go:229 klog.Fatalf("Error creating storage factory config: %v", err) // instance.go:233 klog.Fatalf("Error creating leases: %v", err) // instance.go:250 klog.Fatalf("Reconciler not implemented: %v", c.Extra.EndpointReconcilerType) // instance.go:270 klog.Fatalf("Error determining service IP ranges: %v", err) ``` |
| **Impact** | Using `klog.Fatalf` instead of returning errors prevents proper testing of error paths (test processes are killed), prevents graceful shutdown (deferred functions are not called), and makes error handling non-composable (callers cannot decide how to handle the error). This pattern is particularly concerning in the API server initialization path where a misconfiguration should produce a clear error message and orderly shutdown, not an abrupt process termination. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-023] |

---

## 3. Correctness Risk Register

This section catalogs correctness risks as structured entries documenting assumptions, their violation conditions, and existing (or missing) guards.

---

#### **CORRECT-024**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-024 |
| **Category** | Correctness Risk |
| **Title** | Controller reconciliation assumes informer cache is eventually consistent |
| **Affected Component** | `pkg/controller/*` (all workqueue-based controllers), `client-go/tools/cache` |
| **Assumption** | All workqueue-based controllers assume that informer listers reflect the latest API server state within a bounded resync period. The reconciliation loop trusts lister results for making decisions about child resource creation, deletion, and status updates. |
| **Violation Condition** | Prolonged network partitions between the controller manager and API server, or API server overload causing watch disconnections, can cause the informer cache to become stale beyond the resync period. If the API server's watch stream falls behind or is disconnected without reconnection, the cache may serve arbitrarily old data. |
| **Guard Status** | **Partial guard:** Informers implement periodic resync (default varies by controller) that triggers a full relist. However, between resyncs, the cache can be stale. The `WaitForNamedCacheSyncWithContext()` call in `Run()` ensures initial sync before workers start, but does not guard against subsequent staleness. |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go:85-100` (lister usage), `staging/src/k8s.io/client-go/tools/cache/reflector.go:365-374` (resync mechanism) |
| **Impact** | High — stale cache causes controllers to make incorrect reconciliation decisions, potentially creating or deleting resources based on outdated state |
| **Evidence** | All controllers read from listers (`dc.dLister`, `dc.rsLister`, `dc.podLister`) throughout their sync functions without verifying freshness. The reflector's `RunWithContext` (line 365–374) uses `BackoffUntil` with error handling, meaning reconnection is attempted after watch failures, but there is no explicit freshness guarantee between reconnections. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-024] |

---

#### **CORRECT-025**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-025 |
| **Category** | Correctness Risk |
| **Title** | PLEG assumes container lifecycle events are not lost between relist cycles |
| **Affected Component** | `pkg/kubelet/pleg` (Kubelet Pod Lifecycle Event Generator) |
| **Assumption** | The GenericPLEG assumes that no container can be created, run to completion, and be garbage collected within a single relist period. As documented in the code comments (generic.go lines 42–52), the system depends on containers being visible for at least one relist cycle to generate accurate lifecycle events. |
| **Violation Condition** | If a container's entire lifecycle (creation → running → termination → garbage collection) completes within one relist period (default 1 second), the PLEG will never observe the container and no lifecycle events will be generated. This could happen with extremely short-lived init containers or containers killed immediately after creation. |
| **Guard Status** | **Partial guard:** The default relist period is 1 second (`genericPlegRelistPeriod = 1s`), which makes the window very small. The container runtime garbage collection has its own minimum age setting (`MinAge` in `GCPolicy`). However, there is no formal guarantee that the GC minimum age exceeds the relist period. |
| **Source Location** | `pkg/kubelet/pleg/generic.go:42-52` (assumption documentation), `pkg/kubelet/pleg/generic.go:155-161` (relist period) |
| **Impact** | Medium — lost events cause stale pod status, which self-corrects on the next relist cycle that catches the container's final state |
| **Evidence** | The GenericPLEG code includes an explicit comment documenting this assumption, indicating it is a known risk. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-025] |

---

#### **CORRECT-026**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-026 |
| **Category** | Correctness Risk |
| **Title** | Garbage collector proceeds with potentially incomplete resource monitor sync |
| **Affected Component** | `pkg/controller/garbagecollector` (Garbage Collector Controller) |
| **Assumption** | The garbage collector assumes that its dependency graph builder has a complete view of all resources in the cluster before beginning garbage collection. |
| **Violation Condition** | If some resource monitors fail to sync within the `initialSyncTimeout` period, the garbage collector logs a warning ("not all resource monitors could be synced, proceeding anyways") and begins garbage collection with an incomplete view of the cluster's resource graph. |
| **Guard Status** | **No guard:** The code explicitly proceeds without full sync. Line 164 logs the warning and execution continues unconditionally. Resources not yet synced may be incorrectly identified as orphans and deleted. |
| **Source Location** | `pkg/controller/garbagecollector/garbagecollector.go:161-167` |
| **Impact** | High — proceeding with incomplete data could cause the garbage collector to delete resources that have owners not yet visible in the incomplete graph |
| **Evidence** | ```go // garbagecollector.go:161-167 if !cache.WaitForNamedCacheSyncWithContext(syncCtx, func() bool { return gc.dependencyGraphBuilder.IsSynced(logger) }) { logger.Info("Garbage collector: not all resource monitors could be synced, proceeding anyways") } else { logger.Info("Garbage collector: all resource monitors have synced") } ``` |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P0-CORRECT-026] |

---

#### **CORRECT-027**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-027 |
| **Category** | Correctness Risk |
| **Title** | Scheduler assume-then-bind creates cache state divergence window |
| **Affected Component** | `pkg/scheduler` (kube-scheduler) |
| **Assumption** | The scheduler assumes that the bind operation will succeed after a pod is "assumed" in the scheduler cache. The cache is updated optimistically to allow scheduling of subsequent pods without waiting for the API server bind to complete. |
| **Violation Condition** | If the bind fails (e.g., API server error, node becomes unschedulable, resource conflict), the scheduler cache contains stale assumptions about node resource availability until `ForgetPod` is called in the error handler. If `ForgetPod` itself fails, the stale assumption persists indefinitely (since `durationToExpireAssumedPod = 0`). |
| **Guard Status** | **Partial guard:** The `handleBindingCycleError` method calls `ForgetPod` to clean up the assumption on bind failure. However, `ForgetPod` failure is handled via `utilruntime.HandleErrorWithContext` (logged but not retried), meaning the stale assumption can persist. The `durationToExpireAssumedPod = 0` setting in `scheduler.go` means there is no TTL-based cleanup as a safety net. |
| **Source Location** | `pkg/scheduler/schedule_one.go:195-208` (assume), `pkg/scheduler/schedule_one.go:123-135` (async bind), `pkg/scheduler/scheduler.go` (`durationToExpireAssumedPod = 0`) |
| **Impact** | High — stale assumptions cause cascading scheduling errors: subsequent pods may be placed on over-committed nodes or avoid under-utilized nodes |
| **Evidence** | `durationToExpireAssumedPod` is defined as 0 in scheduler.go, meaning assumed pods never expire from cache automatically. Cleanup relies entirely on explicit `ForgetPod` calls in error paths. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-027] |

---

#### **CORRECT-028**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-028 |
| **Category** | Correctness Risk |
| **Title** | Proxy rule synchronization is non-atomic — partial rule application during sync |
| **Affected Component** | `pkg/proxy/iptables`, `pkg/proxy/ipvs` (kube-proxy) |
| **Assumption** | The proxy `syncProxyRules()` method assumes that it can update iptables/IPVS rules atomically, or that partial application during a sync cycle does not cause traffic disruption. |
| **Violation Condition** | The `syncProxyRules` method holds `mu sync.Mutex` while reading the service/endpoint maps but must release it before making potentially slow iptables/IPVS system calls. During rule application, new service/endpoint changes may arrive. Additionally, the iptables rule application itself is not atomic — rules are applied one at a time, and a failure mid-way leaves the system in a partially updated state. |
| **Guard Status** | **Partial guard:** The `BoundedFrequencyRunner` coalesces rapid changes, and the next sync cycle will attempt to correct any partial application. However, there is no rollback mechanism for partially applied rules. |
| **Source Location** | `pkg/proxy/iptables/proxier.go:75-200` (Proxier struct with mu), `pkg/proxy/ipvs/proxier.go:162-200` (equivalent) |
| **Impact** | Medium — partial rule application can cause brief traffic blackholes or incorrect routing for specific services during the sync window |
| **Evidence** | Both iptables and IPVS Proxier structs use `mu sync.Mutex` to protect `svcPortMap` and `endpointsMap`. The `syncRunner *runner.BoundedFrequencyRunner` governs call frequency but not atomicity of the rule application itself. |
| **Inference Flag** | INFERRED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-028] |

---

#### **CORRECT-029**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-029 |
| **Category** | Correctness Risk |
| **Title** | Reflector backoff strategy assumes API server recovery within bounded time |
| **Affected Component** | `client-go/tools/cache` (Reflector — affects all informer-based components) |
| **Assumption** | The reflector's exponential backoff manager (configured with `800ms` initial delay, `30s` max delay, `2min` reset period, factor `2.0`) assumes that the API server will recover and become accessible within a reasonable time. If the API server is down for an extended period, the reflector will continue retrying at the maximum backoff interval (30–60 seconds) indefinitely. |
| **Violation Condition** | Extended API server outage (>2 minutes) causes the reflector to enter a steady-state retry loop at maximum backoff. Upon recovery, the backoff resets (after 2 minutes of success), but the reflector must re-list all resources, which may cause a thundering herd if many reflectors recover simultaneously. |
| **Guard Status** | **Partial guard:** The backoff parameters are tuned to reduce API server load during outages (0.22 QPS at maximum backoff, as documented in the comment). However, there is no jitter in the recovery phase — all reflectors that started backing off around the same time will reset their backoff simultaneously. |
| **Source Location** | `staging/src/k8s.io/client-go/tools/cache/reflector.go:279-282` |
| **Impact** | Medium — thundering herd on recovery can overwhelm the API server, potentially causing a cascading failure cycle |
| **Evidence** | ```go // reflector.go:282 backoffManager: wait.NewExponentialBackoffManager(800*time.Millisecond, 30*time.Second, 2*time.Minute, 2.0, 1.0, reflectorClock), ``` The jitter factor is `1.0` (no additional randomization beyond the base jitter in `ExponentialBackoffManager`). The comment at lines 279–281 documents the design rationale. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-029] |

---

#### **CORRECT-030**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-030 |
| **Category** | Correctness Risk |
| **Title** | Controller endpoint reconciliation TTL may expire under etcd load |
| **Affected Component** | `pkg/controlplane` (kube-apiserver endpoint reconciler) |
| **Assumption** | The API server endpoint reconciler assumes that endpoint records can be refreshed within the TTL period (`DefaultEndpointReconcilerTTL = 15s`) and that the reconciliation interval (`DefaultEndpointReconcilerInterval = 10s`) provides sufficient margin. |
| **Violation Condition** | Under heavy etcd load or slow network conditions, the endpoint reconciliation call may take longer than the 5-second margin (15s TTL - 10s interval). If reconciliation fails, the endpoint record expires and the API server drops out of the kubernetes service endpoint list, causing client-side load balancing to skip this server. |
| **Guard Status** | **Configurable guard:** The `MasterEndpointReconcileTTL` is configurable (documented in `instance.go` lines 163–170), with a recommendation to increase it in very large clusters. However, the default values assume low-latency etcd access. The ratio of interval-to-TTL (2/3) is documented. |
| **Source Location** | `pkg/controlplane/instance.go:113-115` (defaults), `pkg/controlplane/instance.go:163-170` (documentation) |
| **Impact** | High — expired endpoint records cause API server unavailability from the perspective of the kubernetes service discovery |
| **Evidence** | ```go // instance.go:113-115 DefaultEndpointReconcilerInterval = 10 * time.Second DefaultEndpointReconcilerTTL = 15 * time.Second ``` Comment at lines 163–170 explicitly warns: "In very large clusters, this value may be increased to reduce the possibility that the master endpoint record expires (due to other load on the etcd server)." |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-030] |

---

#### **CORRECT-031**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-031 |
| **Category** | Correctness Risk |
| **Title** | Job controller `MaxPodCreateDeletePerSync` caps reconciliation throughput |
| **Affected Component** | `pkg/controller/job` (Job Controller) |
| **Assumption** | The job controller assumes that creating or deleting at most 500 pods per sync cycle (`MaxPodCreateDeletePerSync = 500`) is sufficient to converge the job state within a reasonable number of sync cycles. |
| **Violation Condition** | For jobs with parallelism greater than 500, or when a large job needs rapid scale-down, a single sync cycle cannot complete the desired state transition. This requires multiple sync cycles to converge, during which time the job's actual pod count diverges significantly from the desired count. |
| **Guard Status** | **By design:** This is an intentional throttle to prevent API server overload from large batch operations. The workqueue will re-enqueue the job key, and subsequent sync cycles will continue the operation. However, convergence time is proportional to `ceil(desired_changes / 500) * sync_interval`. |
| **Source Location** | `pkg/controller/job/job_controller.go:62-63` |
| **Impact** | Low — this is by design, but large jobs may experience longer-than-expected convergence times |
| **Evidence** | ```go // job_controller.go:62-63 MaxPodCreateDeletePerSync = 500 ``` |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-031] |

---

#### **CORRECT-032**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-032 |
| **Category** | Correctness Risk |
| **Title** | IPVS proxy relies on kernel sysctl settings for correct behavior |
| **Affected Component** | `pkg/proxy/ipvs` (kube-proxy IPVS mode) |
| **Assumption** | The IPVS proxy mode assumes that specific Linux kernel sysctl parameters are configured correctly (`net/ipv4/vs/conntrack`, `net/ipv4/vs/conn_reuse_mode`, `net/ipv4/vs/expire_nodest_conn`, `net/ipv4/vs/expire_quiescent_template`, `net/ipv4/ip_forward`, `net/ipv4/conf/all/arp_ignore`, `net/ipv4/conf/all/arp_announce`). |
| **Violation Condition** | If the sysctl parameters cannot be set (e.g., insufficient privileges, read-only sysfs, container restrictions), the proxy may function with incorrect connection tracking, ARP behavior, or IP forwarding, causing subtle networking issues that are difficult to diagnose. |
| **Guard Status** | **Partial guard:** The `NewProxier` function sets these sysctls during initialization. However, the sysctl settings can be overridden after proxy startup by other system components or by the node administrator, and the proxy does not continuously verify that the settings remain correct. |
| **Source Location** | `pkg/proxy/ipvs/proxier.go:100-108` |
| **Impact** | Medium — incorrect sysctl settings cause silent networking issues (connection reuse failures, ARP storms, routing problems) that are difficult to attribute to the proxy |
| **Evidence** | ```go // ipvs/proxier.go:100-108 const ( sysctlVSConnTrack = "net/ipv4/vs/conntrack" sysctlConnReuse = "net/ipv4/vs/conn_reuse_mode" sysctlExpireNoDestConn = "net/ipv4/vs/expire_nodest_conn" sysctlExpireQuiescentTemplate = "net/ipv4/vs/expire_quiescent_template" sysctlForward = "net/ipv4/ip_forward" sysctlArpIgnore = "net/ipv4/conf/all/arp_ignore" sysctlArpAnnounce = "net/ipv4/conf/all/arp_announce" ) ``` |
| **Inference Flag** | INFERRED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-032] |

---

#### **CORRECT-033**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-033 |
| **Category** | Correctness Risk |
| **Title** | Reflector WatchList fallback creates silent behavioral mode switch |
| **Affected Component** | `client-go/tools/cache` (Reflector — affects all informer-based components) |
| **Assumption** | The reflector assumes that WatchList semantics are supported by the API server. When not supported, it falls back to regular list-then-watch without notifying the user beyond a V(4) log message. |
| **Violation Condition** | When the API server does not support WatchList, the reflector silently switches to the legacy list-then-watch flow. This behavioral switch happens transparently, but the two modes have different consistency characteristics: WatchList provides streaming consistency from a specific resource version, while list-then-watch has a gap between the list completion and the watch start. |
| **Guard Status** | **By design:** The fallback is intentional and logged. However, the V(4) log level means it will not be visible in most production configurations (default verbosity is 0–2). |
| **Source Location** | `staging/src/k8s.io/client-go/tools/cache/reflector.go:422-437` |
| **Impact** | Low — the fallback mode has been in use for years and is well-tested, but the silent mode switch could confuse operators investigating consistency issues |
| **Evidence** | ```go // reflector.go:428-436 if err != nil { logger.V(4).Info( "Data couldn't be fetched in watchlist mode. Falling back to regular list.", "err", err, ) fallbackToList = true w = nil } ``` |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-033] |

---

## 4. Fragile Logic Inventory

This section catalogs logic patterns that are fragile — dependent on undocumented call order, specific timing assumptions, or external system behavior without adequate guards.

---

#### **CORRECT-034**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-034 |
| **Category** | Fragile Logic |
| **Title** | Controller `Run()` startup assumes informer cache sync completes within context deadline |
| **Source Location** | `pkg/controller/deployment/deployment_controller.go` (Run method), `pkg/controller/garbagecollector/garbagecollector.go:161-167` |
| **Description** | Every controller's `Run()` method calls `cache.WaitForNamedCacheSyncWithContext()` before starting workers. This function blocks until all informer caches are synced or the context is cancelled. If the context has a deadline (e.g., from leader election renewal timeout), a slow sync can cause the context to be cancelled, which shuts down the entire controller. The garbage collector explicitly handles this by proceeding without full sync (CORRECT-026), but most controllers simply exit their `Run()` method if sync fails. |
| **Evidence** | The common pattern across all controllers: ```go if !cache.WaitForNamedCacheSyncWithContext(ctx, ...) { return } ``` If this returns false, the controller silently exits its `Run()` method. Whether workers were started, whether the event broadcaster is cleaned up, and whether the caller is notified depend on the specific controller's defer chain. |
| **Impact** | If the API server is slow or overloaded during controller manager startup, some controllers may fail to sync their caches and silently exit their `Run()` method. The controller manager does not automatically restart individual controllers, so the failed controller remains inactive until the controller manager process is restarted or loses and re-acquires leader election. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-034] |

---

#### **CORRECT-035**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-035 |
| **Category** | Fragile Logic |
| **Title** | PLEG health check is timing-dependent — false positives during container runtime slowdowns |
| **Source Location** | `pkg/kubelet/pleg/generic.go:178-192` |
| **Description** | The `Healthy()` method checks whether the time since the last successful relist exceeds `RelistThreshold` (typically 3 minutes). If a single relist takes longer than the threshold (e.g., due to a slow container runtime), the PLEG is declared unhealthy. This health check does not distinguish between "relist is running but slow" and "relist has stopped entirely." A long-running relist is functionally correct (it will eventually complete) but triggers the same unhealthy signal as a deadlocked PLEG. |
| **Evidence** | ```go // generic.go:180-192 func (g *GenericPLEG) Healthy() (bool, error) { relistTime := g.getRelistTime() if relistTime.IsZero() { return false, fmt.Errorf("pleg has yet to be successful") } metrics.PLEGLastSeen.Set(float64(relistTime.Unix())) elapsed := g.clock.Since(relistTime) if elapsed > g.relistDuration.RelistThreshold { return false, fmt.Errorf("pleg was last seen active %v ago; threshold is %v", elapsed, g.relistDuration.RelistThreshold) } return true, nil } ``` |
| **Impact** | False PLEG unhealthy signals during container runtime slowdowns cause the kubelet's health check to fail, which can trigger node tainting or pod eviction — amplifying the problem by creating more work for the already-slow runtime. The threshold-based check creates a cliff effect: a relist completing at 2m59s is "healthy" while one completing at 3m01s is "unhealthy," regardless of whether the system is making forward progress. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P1-CORRECT-035] |

---

#### **CORRECT-036**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-036 |
| **Category** | Fragile Logic |
| **Title** | Scheduler scheduling cycle has complex multi-phase rollback with manual cleanup ordering |
| **Source Location** | `pkg/scheduler/schedule_one.go:140-260` |
| **Description** | The `schedulingCycle` function proceeds through a strict sequence: `SchedulePod` → `assume` → `RunReservePluginsReserve` → `RunPermitPlugins`. At each stage after `assume`, failure requires manual rollback: `RunReservePluginsUnreserve` followed by `Cache.ForgetPod`. This rollback logic is duplicated at two points (lines 211–231 for Reserve failure and lines 235–255 for Permit failure), with each duplication performing the same cleanup in the same order. If a new phase is added between Reserve and Permit, the developer must remember to add rollback logic at every subsequent failure point. |
| **Evidence** | Reserve failure cleanup (lines 211–216): ```go schedFramework.RunReservePluginsUnreserve(ctx, state, assumedPod, scheduleResult.SuggestedHost) if forgetErr := sched.Cache.ForgetPod(logger, assumedPod); forgetErr != nil { utilruntime.HandleErrorWithContext(ctx, forgetErr, "Scheduler cache ForgetPod failed") } ``` Permit failure cleanup (lines 237–240): ```go schedFramework.RunReservePluginsUnreserve(ctx, state, assumedPod, scheduleResult.SuggestedHost) if forgetErr := sched.Cache.ForgetPod(logger, assumedPod); forgetErr != nil { utilruntime.HandleErrorWithContext(ctx, forgetErr, "Scheduler cache ForgetPod failed") } ``` These are identical cleanup blocks duplicated at two failure points. |
| **Impact** | The manual rollback ordering is fragile: if the cleanup order is wrong (e.g., `ForgetPod` before `Unreserve`), plugins may not see the correct state during unreserve. The duplication means a bug fix in one cleanup path may not be applied to the other. Adding new scheduling phases increases the rollback surface linearly. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-036] |

---

#### **CORRECT-037**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-037 |
| **Category** | Fragile Logic |
| **Title** | Kubelet `NewMainKubelet` has 30+ parameters with implicit ordering dependencies |
| **Source Location** | `pkg/kubelet/kubelet.go:422-448` |
| **Description** | The `NewMainKubelet` function accepts over 30 parameters, many of which have implicit dependencies on each other. For example, `containerGCPolicy` depends on `minimumGCAge`, `maxPerPodContainerCount`, and `maxContainerCount`. The `makePodSourceConfig` call on line 493 depends on `kubeDeps.KubeClient`, `nodeName`, and `nodeHasSynced` — the latter is set up only if `kubeDeps.KubeClient != nil` (lines 472–489). These implicit dependencies are enforced only by the ordering of statements within the function body, not by the type system or explicit validation. |
| **Evidence** | Function signature spans lines 422–448 with parameters including `kubeCfg`, `kubeDeps`, `crOptions`, `hostname`, `nodeName`, `nodeIPs`, `providerID`, `cloudProvider`, `certDirectory`, `rootDirectory`, `podLogsDirectory`, `imageCredentialProviderConfigPath`, `imageCredentialProviderBinDir`, `registerNode`, `registerWithTaints`, `allowedUnsafeSysctls`, `experimentalMounterPath`, `kernelMemcgNotification`, `experimentalNodeAllocatableIgnoreEvictionThreshold`, `minimumGCAge`, `maxPerPodContainerCount`, `maxContainerCount`, `nodeLabels`, `nodeStatusMaxImages`, `seccompDefault`. |
| **Impact** | The long parameter list and implicit dependencies make the function fragile to refactoring. Reordering initialization statements (e.g., moving `nodeHasSynced` setup after `makePodSourceConfig`) would cause a nil-pointer panic at runtime with no compile-time warning. The function is also difficult to test in isolation due to the large number of required parameters. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-037] |

---

#### **CORRECT-038**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-038 |
| **Category** | Fragile Logic |
| **Title** | Proxy `initialSync` flag depends on first sync call to clear it |
| **Source Location** | `pkg/proxy/ipvs/proxier.go:177-183` |
| **Description** | The IPVS Proxier struct has an `initialSync bool` field (line 183) that is set to `true` when a new proxier is created and cleared to `false` after the first sync. This flag enables specific logic during the first proxy sync (e.g., updating weights of existing IPVS destinations). The flag's behavior depends on the first `syncProxyRules()` call succeeding — if the first sync fails or is interrupted, the flag may not be cleared, causing "initial sync" logic to run repeatedly on subsequent attempts. |
| **Evidence** | ```go // ipvs/proxier.go:177-183 // initialSync is a bool indicating if the proxier is syncing for the first time. // It is set to true when a new proxier is initialized and then set to false on all // future syncs. // This lets us run specific logic that's required only during proxy startup. // For eg: it enables us to update weights of existing destinations only on startup // saving us the cost of querying and updating real servers during every sync. initialSync bool ``` |
| **Impact** | If the first sync fails partway through, the `initialSync` flag may not be cleared, causing the IPVS weight update logic to run on the next sync as well. This is a minor efficiency concern (redundant weight updates) rather than a correctness issue, but it demonstrates a fragile state management pattern where a boolean flag's lifecycle is tied to successful execution of a complex multi-step operation. |
| **Inference Flag** | INFERRED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-038] |

---

#### **CORRECT-039**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-039 |
| **Category** | Fragile Logic |
| **Title** | Garbage collector REST mapper reset is a "leaky abstraction" depending on internal behavior |
| **Source Location** | `pkg/controller/garbagecollector/garbagecollector.go:224-227` |
| **Description** | The garbage collector's `Sync()` method calls `gc.restMapper.Reset()` to invalidate cached discovery information. The code comment (lines 224–226) explicitly acknowledges this is a leaky abstraction: "Resetting the REST mapper will also invalidate the underlying discovery client. This is a leaky abstraction and assumes behavior about the REST mapper, but we'll deal with it for now." This dependency on internal behavior of the REST mapper means that changes to the REST mapper's implementation could silently break the garbage collector's discovery refresh logic. |
| **Evidence** | ```go // garbagecollector.go:224-227 // Resetting the REST mapper will also invalidate the underlying discovery // client. This is a leaky abstraction and assumes behavior about the REST // mapper, but we'll deal with it for now. gc.restMapper.Reset() ``` |
| **Impact** | If the REST mapper implementation changes to no longer invalidate its discovery client on `Reset()`, the garbage collector will continue using stale discovery information after new CRDs are added or removed, potentially failing to garbage collect resources of new types or incorrectly garbage collecting resources of removed types. The explicit "we'll deal with it for now" comment indicates this is known technical debt. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-039] |

---

#### **CORRECT-040**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-040 |
| **Category** | Fragile Logic |
| **Title** | Eviction manager `synchronize` return value encoding: nil-pods-with-error vs non-nil-pods-with-nil-error |
| **Source Location** | `pkg/kubelet/eviction/eviction_manager.go:209-222` |
| **Description** | The eviction manager's monitoring loop uses a fragile return-value protocol to determine behavior: if `synchronize` returns non-nil `evictedPods` AND nil `err`, the loop waits for pod cleanup; otherwise, it logs the error and sleeps. This means the semantics of the return values are coupled: `(nil, nil)` means "nothing to do", `(non-nil, nil)` means "evicted pods, wait for cleanup", `(nil, non-nil)` means "error, retry after sleep", but `(non-nil, non-nil)` is ambiguous — the code treats it as the error case (skips cleanup wait). |
| **Evidence** | ```go // eviction_manager.go:211-222 evictedPods, err := m.synchronize(ctx, diskInfoProvider, podFunc) if evictedPods != nil && err == nil { logger.Info("Eviction manager: pods evicted, waiting for pod to be cleaned up") m.waitForPodsCleanup(logger, podCleanedUpFunc, evictedPods) } else { if err != nil { logger.Error(err, "Eviction manager: failed to synchronize") } time.Sleep(monitoringInterval) } ``` |
| **Impact** | If `synchronize` returns both evicted pods AND an error (e.g., some pods were evicted but others failed), the monitoring loop skips the cleanup wait for the successfully evicted pods. This could cause the eviction manager to start a new synchronize cycle before the previously evicted pods have been fully cleaned up, potentially leading to premature re-eviction decisions or exceeding the intended eviction rate. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P2-CORRECT-040] |

---

#### **CORRECT-041**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-041 |
| **Category** | Fragile Logic |
| **Title** | Reflector `watchWithResync` relies on deferred cancel-then-wait ordering for race safety |
| **Source Location** | `staging/src/k8s.io/client-go/tools/cache/reflector.go:478-493` |
| **Description** | The `watchWithResync` method creates a goroutine for `startResync` and uses a `defer` chain for cleanup: `cancel()` then `wg.Wait()`. The code comment (lines 481–484) explicitly documents the ordering requirement: "Waiting for completion of the goroutine is relevant for race detector. Without this, there is a race between 'this function returns + code waiting for it' and 'goroutine does something.'" This cleanup ordering is correct but fragile — if the defer chain is reordered (e.g., `wg.Wait()` before `cancel()`), the function would deadlock because the goroutine never receives the cancellation signal. |
| **Evidence** | ```go // reflector.go:478-493 func (r *Reflector) watchWithResync(ctx context.Context, w watch.Interface) error { resyncerrc := make(chan error, 1) cancelCtx, cancel := context.WithCancel(ctx) var wg wait.Group defer func() { cancel() wg.Wait() }() wg.Start(func() { r.startResync(cancelCtx, resyncerrc) }) return r.watch(ctx, w, resyncerrc) } ``` |
| **Impact** | The fragility is mitigated by the explicit comment documenting the ordering requirement. However, the single defer function containing both `cancel()` and `wg.Wait()` in sequence is a pattern that could be inadvertently broken by a future refactor that separates them into individual defers (which execute in LIFO order, potentially reversing the intended sequence). |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-041] |

---

#### **CORRECT-042**

| Field | Value |
|-------|-------|
| **Finding ID** | CORRECT-042 |
| **Category** | Fragile Logic |
| **Title** | Garbage collector discovery sync uses `reflect.DeepEqual` for change detection on complex maps |
| **Source Location** | `pkg/controller/garbagecollector/garbagecollector.go:213` |
| **Description** | The garbage collector's `Sync()` method uses `reflect.DeepEqual(oldResources, newResources)` to determine whether the set of deletable resources has changed between discovery cycles. Using `reflect.DeepEqual` on `map[schema.GroupVersionResource]struct{}` is correct but fragile: it performs deep comparison via reflection, which is slow for large maps and can produce unexpected results if the map value type is changed from `struct{}` to a type with pointer fields. |
| **Evidence** | ```go // garbagecollector.go:213 if reflect.DeepEqual(oldResources, newResources) { logger.V(5).Info("no resource updates from discovery, skipping garbage collector sync") return } ``` |
| **Impact** | For the current implementation with `map[schema.GroupVersionResource]struct{}`, `reflect.DeepEqual` is correct and the performance cost is acceptable (map keys are value types). However, if the map value type is changed to include mutable state, the comparison could produce false negatives (treating equal maps as different), triggering unnecessary monitor resyncs that consume API server resources. |
| **Inference Flag** | CONFIRMED |
| **Recommendation Ref** | [08_IMPROVEMENT_ROADMAP.md — P3-CORRECT-042] |

---

## 5. Summary Statistics

### Finding Distribution

| Category | Count | Finding IDs |
|----------|-------|-------------|
| Redundant Logic | 8 | CORRECT-001 through CORRECT-008 |
| Goroutine Lifecycle Issues | 4 | CORRECT-009, CORRECT-010, CORRECT-011, CORRECT-012 |
| Channel Misuse | 2 | CORRECT-013, CORRECT-014 |
| Context Propagation Failures | 4 | CORRECT-015, CORRECT-016, CORRECT-017, CORRECT-018 |
| Unhandled Error Returns | 3 | CORRECT-019, CORRECT-020, CORRECT-021 |
| Improper Async Handling | 2 | CORRECT-022, CORRECT-023 |
| Correctness Risk Register | 10 | CORRECT-024 through CORRECT-033 |
| Fragile Logic | 9 | CORRECT-034 through CORRECT-042 |
| **Total** | **42** | |

### Severity Distribution (Correctness Risk Register)

| Severity | Count | Finding IDs |
|----------|-------|-------------|
| High | 4 | CORRECT-024, CORRECT-026, CORRECT-027, CORRECT-030 |
| Medium | 4 | CORRECT-025, CORRECT-028, CORRECT-029, CORRECT-032 |
| Low | 2 | CORRECT-031, CORRECT-033 |

### Inference Flag Distribution

| Flag | Count |
|------|-------|
| CONFIRMED | 39 |
| INFERRED | 3 |

### Components Assessed

| Component | Findings Referencing |
|-----------|---------------------|
| `pkg/controller/*` | CORRECT-001 through CORRECT-008, CORRECT-010, CORRECT-024, CORRECT-034 |
| `pkg/kubelet/*` | CORRECT-009, CORRECT-012, CORRECT-013, CORRECT-015, CORRECT-016, CORRECT-017, CORRECT-018, CORRECT-025, CORRECT-035, CORRECT-037, CORRECT-040 |
| `pkg/scheduler/*` | CORRECT-011, CORRECT-022, CORRECT-027, CORRECT-036 |
| `pkg/proxy/*` | CORRECT-006, CORRECT-028, CORRECT-032, CORRECT-038 |
| `pkg/controlplane/*` | CORRECT-023, CORRECT-030 |
| `staging/src/k8s.io/client-go/*` | CORRECT-014, CORRECT-029, CORRECT-033, CORRECT-041 |
| `pkg/controller/garbagecollector/*` | CORRECT-026, CORRECT-039, CORRECT-042 |

---

## Cross-References

- **Consistency findings**: See [01_CONSISTENCY_AND_STYLE.md](01_CONSISTENCY_AND_STYLE.md) for naming and pattern consistency across the same controller boilerplate identified in CORRECT-001 through CORRECT-007
- **Design quality**: See [03_DESIGN_QUALITY.md](03_DESIGN_QUALITY.md) for error handling patterns related to CORRECT-008, CORRECT-019, CORRECT-020, CORRECT-021, CORRECT-023
- **Testability**: See [06_TESTABILITY_AND_RELIABILITY.md](06_TESTABILITY_AND_RELIABILITY.md) for coupling and side-effect concerns related to CORRECT-037 and the context propagation findings
- **Improvement roadmap**: See [08_IMPROVEMENT_ROADMAP.md](08_IMPROVEMENT_ROADMAP.md) for prioritized recommendations addressing all CORRECT-XXX findings
- **Risk assessment**: See [09_QUALITY_RISK_ASSESSMENT.md](09_QUALITY_RISK_ASSESSMENT.md) for architectural risk analysis incorporating the correctness risks documented here
