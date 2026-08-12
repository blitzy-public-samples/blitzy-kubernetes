# Copyright The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Pod bodies for the V2 Pod Security port: the privileged, hostPID and plain pods.

AAP §0.5.1 / §0.4.2.2 (the V2 blueprint) + tech-spec §6.4.4.3: Pod Security
enforcement - enforce=baseline rejects privileged and hostPID pods, warn=restricted
admits but warns. These are the pod literals of
``TestPodSecurityEnforceBaselineRejectsPrivileged`` at
test/integration/auth/podsecurity_test.go line 363, ported field for field.

Three builders, one per pod in the Go test being ported, each returning a fresh
``kubernetes.client.V1Pod``::

    from tests.fixtures.pss_pods import hostpid_pod, privileged_pod, warn_pod

    privileged_pod()   # must be REJECTED by a namespace labelled enforce=baseline
    hostpid_pod()      # must be REJECTED by a namespace labelled enforce=baseline
    warn_pod()         # must be ADMITTED under warn=restricted, and must warn

WHY THESE THREE SHAPES ARE THE ASSERTION SURFACE

The control under test is Pod Security admission, and a rejection test is only ever
as strong as the pod it submits. Every field below is load-bearing rather than
decorative:

* ``privileged_pod`` sets ``securityContext.privileged: true`` on its container.
  That one field IS the baseline violation the first case asserts on. Drop it and
  the pod becomes baseline-compliant, the API server admits it, and the 403
  assertion is the only thing that fails - or worse, a later reader "fixes" the
  test by relaxing the expected status and leaves a green suite that proves
  nothing about enforcement.
* ``hostpid_pod`` sets ``hostPID: true`` on the pod spec and carries NO container
  securityContext. Same reasoning, different violation: it proves enforcement
  covers a pod-level field and not merely a container-level one.
* ``warn_pod`` is a plain pod and MUST STAY PLAIN. Carrying no securityContext, it
  violates the restricted profile - no ``runAsNonRoot``, no ``seccompProfile``, no
  drop-ALL capabilities, no ``allowPrivilegeEscalation: false`` - while still
  complying with baseline. That is precisely what the third case needs, because it
  asserts ADMISSION WITH A WARNING rather than rejection. Adding a securityContext
  to satisfy restricted would silence the warning; adding a baseline violation
  would turn the admission into a rejection. Either edit inverts the case.

All three set ``serviceAccountName: default`` because the ported suite starts an API
server without controllers, so the namespace's ``default`` ServiceAccount is not
auto-created while the ServiceAccount admission plugin still runs. The namespace
fixture creates that ServiceAccount up front - mirroring
staging/src/k8s.io/pod-security-admission/test/run.go lines 229-234 - so that any
rejection observed here is genuinely a PodSecurity Forbidden and not a
ServiceAccount error masking it. Naming the ServiceAccount on the pod is the other
half of that arrangement, and it is why the field is set on the plain pods too.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

It is data plus pure builders: no assertion, no pytest fixture, no API call, no I/O,
no import-time side effect. Four omissions in particular are decisions, not gaps:

* No namespace. ``metadata.namespace`` is left unset exactly as the Go pod literals
  leave it, and the consumer passes the namespace to the create call instead
  (``create_namespaced_pod(namespace, body)``). One pod body is therefore usable
  against any namespace, and the pod cannot silently disagree with the namespace it
  was created in.
* No namespace names and no Pod Security labels. Which pod pairs with which
  namespace belongs to the test that makes the assertion: the two rejection cases
  run in ``psa-enforce-baseline``, labelled ``pod-security.kubernetes.io/enforce:
  baseline``, and the warning case runs in ``psa-warn-restricted``, labelled
  ``pod-security.kubernetes.io/warn: restricted``. Those literals live in
  tests/integration/test_podsecurity_baseline.py and its namespace fixture, and are
  named here only so the pairing is discoverable from either end.
* No dry-run. ``dry_run=["All"]`` is a create OPTION the consumer passes, the
  counterpart of ``metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}``; it
  exists to run the full admission chain while persisting nothing, keeping the
  session-shared etcd clean. Encoding it in a pod body would put a request option
  in the wrong object and quietly stop working.
* No warning capture. The lock-guarded recorder that the warning case reads lives in
  tests/helpers/warnings.py, ported from the ``recordingWarningHandler`` the Go test
  reuses. A pod body has no business owning a client hook.

EVERY CALL RETURNS A FRESH OBJECT

Each builder constructs its ``V1Pod``, its ``V1PodSpec``, its container list and its
container on every call, so no two callers can ever share one mutable model. This is
structural isolation rather than a convention to remember: the suite runs under
pytest-randomly and pytest-xdist, where a module-level pod instance mutated by one
test would corrupt another in an order-dependent, parallel-only way. The Go suite
reaches the same place from the other direction, deep-copying a shared pod fixture
before touching it (run.go line 247); handing out a new object is the cheaper and
harder-to-misuse half of that bargain.
"""

# AAP §0.5.1 (the python/tests/fixtures/pss_pods.py row: "Privileged, hostPID, and
# plain pod builders", sourced from test/integration/auth/podsecurity_test.go) /
# §0.4.2.2 (the V2 blueprint, whose three cases are the privileged rejection, the
# hostPID rejection and the warn=restricted admission) / tech-spec §6.4.4.3 (Pod
# Security enforcement: enforce=baseline rejects privileged and hostPID pods,
# warn=restricted admits but warns).
#
# INVARIANT LOCKED BY THIS FILE: the three pod bodies of the V2 port keep EXACTLY
# the fields the Go originals set, and nothing else. privileged-pod carries
# securityContext.privileged=true; hostpid-pod carries hostPID=true and no container
# securityContext; warn-pod carries neither and stays restricted-violating but
# baseline-compliant; all three name the "default" ServiceAccount. Weaken any one of
# those and the corresponding case still runs, still reports, and no longer tests
# what it claims to.
#
# The shapes are measured from test/integration/auth/podsecurity_test.go, not
# recalled: privilegedPod at lines 396-406, hostPIDPod at lines 411-418 and warnPod
# at lines 439-445, inside TestPodSecurityEnforceBaselineRejectsPrivileged at line
# 363. That file is the parity oracle for this port and is never modified.

from typing import Final

from kubernetes.client import V1Container, V1ObjectMeta, V1Pod, V1PodSpec, V1SecurityContext

__all__ = [
    "CONTAINER_IMAGE",
    "CONTAINER_NAME",
    "HOSTPID_POD_NAME",
    "PRIVILEGED_POD_NAME",
    "SERVICE_ACCOUNT_NAME",
    "WARN_POD_NAME",
    "hostpid_pod",
    "privileged_pod",
    "warn_pod",
]

# The literals shared by all three pods, single-sourced so the bodies cannot drift
# apart. Go sets the same three values in all three literals; a constant here means a
# reviewer diffing this module against lines 396-445 of the Go file has three names to
# check rather than nine string occurrences.
CONTAINER_NAME: Final[str] = "c"
CONTAINER_IMAGE: Final[str] = "busybox"

# Named on every pod so a rejection is a PodSecurity Forbidden rather than a
# ServiceAccount error. The namespace fixture creates this ServiceAccount; this module
# only refers to it.
SERVICE_ACCOUNT_NAME: Final[str] = "default"

# The pod names are part of the observable outcome - they appear in the admission error
# and in the Pod Security warning the third case counts - so they are constants a test
# can assert against instead of literals repeated at the call site.
PRIVILEGED_POD_NAME: Final[str] = "privileged-pod"
HOSTPID_POD_NAME: Final[str] = "hostpid-pod"
WARN_POD_NAME: Final[str] = "warn-pod"


def _busybox_container(security_context: V1SecurityContext | None = None) -> V1Container:
    """Build the single container every pod in this module carries.

    Locks the container shape shared by all three pods: name ``c``, image
    ``busybox``, and a securityContext ONLY when the caller supplies one. Leaving
    ``security_context`` at ``None`` is what keeps the hostPID and plain pods free of
    a container securityContext, which the client omits from the wire body exactly as
    Go's ``omitempty`` omits a nil pointer.

    A new ``V1Container`` is returned on every call; the returned object is the
    caller's alone.
    """
    return V1Container(
        name=CONTAINER_NAME,
        image=CONTAINER_IMAGE,
        security_context=security_context,
    )


def privileged_pod(name: str = PRIVILEGED_POD_NAME) -> V1Pod:
    """Build the privileged pod that a namespace labelled enforce=baseline must reject.

    INVARIANT LOCKED: ``securityContext.privileged`` is ``True``. That field is the
    baseline violation under test - the reason the create is expected to fail with
    HTTP 403 Forbidden - so it is never conditional and never defaulted away.

    Ports the ``privilegedPod`` literal at test/integration/auth/podsecurity_test.go
    lines 396-406. ``metadata.namespace`` is deliberately unset: the consumer creates
    the pod in ``psa-enforce-baseline`` with ``dry_run=["All"]``, matching the Go
    original's ``CreateOptions{DryRun: []string{metav1.DryRunAll}}``.

    Args:
        name: Pod name. Defaults to the measured ``privileged-pod``; override it only
            to disambiguate pods within one namespace, never to change what is
            asserted.

    Returns:
        A fresh ``V1Pod``, safe to mutate without affecting any other caller.
    """
    return V1Pod(
        metadata=V1ObjectMeta(name=name),
        spec=V1PodSpec(
            service_account_name=SERVICE_ACCOUNT_NAME,
            containers=[_busybox_container(security_context=V1SecurityContext(privileged=True))],
        ),
    )


def hostpid_pod(name: str = HOSTPID_POD_NAME) -> V1Pod:
    """Build the hostPID pod that a namespace labelled enforce=baseline must reject.

    INVARIANT LOCKED: ``hostPID`` is ``True`` on the POD SPEC and the container
    carries NO securityContext. The violation is deliberately pod-level rather than
    container-level, so the case proves enforcement inspects the whole pod and not
    only its containers.

    Ports the ``hostPIDPod`` literal at test/integration/auth/podsecurity_test.go
    lines 411-418. As with the privileged pod, the namespace and the dry-run option
    belong to the create call, not to this body.

    Args:
        name: Pod name. Defaults to the measured ``hostpid-pod``.

    Returns:
        A fresh ``V1Pod``, safe to mutate without affecting any other caller.
    """
    return V1Pod(
        metadata=V1ObjectMeta(name=name),
        spec=V1PodSpec(
            service_account_name=SERVICE_ACCOUNT_NAME,
            host_pid=True,
            containers=[_busybox_container()],
        ),
    )


def warn_pod(name: str = WARN_POD_NAME) -> V1Pod:
    """Build the plain pod that warn=restricted must ADMIT while surfacing a warning.

    INVARIANT LOCKED: no container securityContext and no ``hostPID`` - a plain pod,
    and it must stay plain. With nothing set it violates the restricted profile
    (missing ``runAsNonRoot``, ``seccompProfile``, drop-ALL capabilities and
    ``allowPrivilegeEscalation: false``) yet complies with baseline, which is the only
    combination that makes the third case meaningful: the create must SUCCEED, because
    enforce is left at the cluster default of privileged, and it must still produce at
    least one Pod Security warning. Hardening this pod would silence the warning;
    adding a baseline violation would turn the admission into a rejection.

    Ports the ``warnPod`` literal at test/integration/auth/podsecurity_test.go lines
    439-445. The consumer creates it in ``psa-warn-restricted`` through a client whose
    warning handler is the lock-guarded recorder from tests/helpers/warnings.py.

    Args:
        name: Pod name. Defaults to the measured ``warn-pod``.

    Returns:
        A fresh ``V1Pod``, safe to mutate without affecting any other caller.
    """
    return V1Pod(
        metadata=V1ObjectMeta(name=name),
        spec=V1PodSpec(
            service_account_name=SERVICE_ACCOUNT_NAME,
            containers=[_busybox_container()],
        ),
    )
