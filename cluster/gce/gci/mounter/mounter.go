/*
Copyright 2017 The Kubernetes Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	// Location of the mount file to use
	chrootCmd        = "chroot"
	mountCmd         = "mount"
	rootfs           = "rootfs"
	nfsRPCBindErrMsg = "mount.nfs: rpc.statd is not running but is required for remote locking.\nmount.nfs: Either use '-o nolock' to keep locks local, or start statd.\nmount.nfs: an incorrect mount option was specified\n"
	rpcBindCmd       = "/sbin/rpcbind"
	defaultRootfs    = "/home/kubernetes/containerized_mounter/rootfs"
	// SECURITY FIX (VULN-010 - CWE-78): Characters that could enable command injection
	// Includes: semicolon, pipe, ampersand, backtick, dollar, parentheses, braces,
	// brackets, angle brackets, backslash, exclamation, hash, tilde, asterisk
	dangerousChars = ";|&`$(){}[]<>\\!#~*"
)

// validateArgs checks for potentially dangerous characters that could enable command injection
// and path traversal patterns in command arguments.
// SECURITY FIX (VULN-010 - CWE-78): Validate arguments before passing to exec.Command
func validateArgs(args []string) error {
	for _, arg := range args {
		// Check for dangerous shell characters that could enable command injection
		if strings.ContainsAny(arg, dangerousChars) {
			return fmt.Errorf("argument contains invalid characters: %q", arg)
		}
		// Check for path traversal patterns that could escape intended directories
		if strings.Contains(arg, "..") {
			return fmt.Errorf("argument contains path traversal pattern: %q", arg)
		}
	}
	return nil
}

// validatePath validates a file path to prevent command injection and path traversal attacks.
// SECURITY FIX (VULN-010 - CWE-78): Validate paths before using in exec.Command
func validatePath(path string) error {
	// Check for dangerous shell characters that could enable command injection
	if strings.ContainsAny(path, dangerousChars) {
		return fmt.Errorf("path contains invalid characters: %q", path)
	}
	// Check for path traversal patterns that could escape intended directories
	if strings.Contains(path, "..") {
		return fmt.Errorf("path contains path traversal pattern: %q", path)
	}
	return nil
}

func main() {

	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Command failed: must provide a command to run.\n")
		return
	}
	path, _ := filepath.Split(os.Args[0])
	rootfsPath := filepath.Join(path, rootfs)
	if _, err := os.Stat(rootfsPath); os.IsNotExist(err) {
		rootfsPath = defaultRootfs
	}
	command := os.Args[1]
	switch command {
	case mountCmd:
		mountErr := mountInChroot(rootfsPath, os.Args[2:])
		if mountErr != nil {
			fmt.Fprintf(os.Stderr, "Mount failed: %v", mountErr)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown command, must be %s", mountCmd)
		os.Exit(1)

	}
}

// MountInChroot is to run mount within chroot with the passing root directory
func mountInChroot(rootfsPath string, args []string) error {
	if _, err := os.Stat(rootfsPath); os.IsNotExist(err) {
		return fmt.Errorf("path <%s> does not exist", rootfsPath)
	}
	// SECURITY FIX (VULN-010 - CWE-78): Validate rootfsPath to prevent path traversal attacks
	if err := validatePath(rootfsPath); err != nil {
		return fmt.Errorf("invalid rootfs path: %w", err)
	}
	// SECURITY FIX (VULN-010 - CWE-78): Validate arguments before command execution
	if err := validateArgs(args); err != nil {
		return fmt.Errorf("invalid argument: %w", err)
	}
	args = append([]string{rootfsPath, mountCmd}, args...)
	output, err := exec.Command(chrootCmd, args...).CombinedOutput()
	if err == nil {
		return nil
	}

	if !strings.EqualFold(string(output), nfsRPCBindErrMsg) {
		// Mount failed but not because of RPC bind error
		return fmt.Errorf("mount failed: %v\nMounting command: %s\nMounting arguments: %v\nOutput: %s", err, chrootCmd, args, string(output))
	}

	// Mount failed because it is NFS V3 and we need to run rpcBind
	output, err = exec.Command(chrootCmd, rootfsPath, rpcBindCmd, "-w").CombinedOutput()
	if err != nil {
		return fmt.Errorf("mount issued for NFS V3 but unable to run rpcbind:\n Output: %s\n Error: %v", string(output), err)
	}

	// Rpcbind is running, try mounting again
	output, err = exec.Command(chrootCmd, args...).CombinedOutput()

	if err != nil {
		return fmt.Errorf("mount failed for NFS V3 even after running rpcBind %s, %v", string(output), err)
	}

	return nil
}
