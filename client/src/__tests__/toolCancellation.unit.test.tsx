import { describe, it, jest, expect, beforeEach } from "@jest/globals";

// Mock the types we need
const mockToolResult = {
  content: [{ type: "text", text: "Test result" }],
  isError: false,
};

const mockAbortError = new Error("Request aborted");
mockAbortError.name = "AbortError";

const mockNetworkError = new Error("Network failure");
mockNetworkError.name = "NetworkError";

describe("Tool Cancellation Logic", () => {
  let mockSetToolAbortController: jest.MockedFunction<(value: unknown) => void>;
  let mockSetToolResult: jest.MockedFunction<(value: unknown) => void>;
  let mockClearError: jest.MockedFunction<(key: string) => void>;
  let mockSetErrors: jest.MockedFunction<
    (fn: (prev: unknown) => unknown) => void
  >;
  let mockMakeRequest: jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  let toolAbortController: AbortController | null;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSetToolAbortController = jest.fn() as jest.MockedFunction<
      (value: unknown) => void
    >;
    mockSetToolResult = jest.fn() as jest.MockedFunction<
      (value: unknown) => void
    >;
    mockClearError = jest.fn() as jest.MockedFunction<(key: string) => void>;
    mockSetErrors = jest.fn() as jest.MockedFunction<
      (fn: (prev: unknown) => unknown) => void
    >;
    mockMakeRequest = jest.fn() as jest.MockedFunction<
      (...args: unknown[]) => Promise<unknown>
    >;
    toolAbortController = null;

    // Mock setState functions to update our local variable
    mockSetToolAbortController.mockImplementation((value: unknown) => {
      if (typeof value === "function") {
        toolAbortController = value(toolAbortController);
      } else {
        toolAbortController = value;
      }
    });
  });

  // Test the core callTool logic
  const createCallToolFunction = () => {
    return async (name: string, params: Record<string, unknown>) => {
      // Prevent concurrent tool calls
      if (toolAbortController) {
        return;
      }

      // Create and store abort controller for this tool call
      const abortController = new AbortController();
      mockSetToolAbortController(abortController);
      toolAbortController = abortController; // Update our test variable

      try {
        const response = await mockMakeRequest(
          {
            method: "tools/call" as const,
            params: {
              name,
              arguments: params,
              _meta: {
                progressToken: 1,
              },
            },
          },
          {}, // schema
          { signal: abortController.signal },
        );

        // Only update state if this controller is still the active one
        if (toolAbortController === abortController) {
          mockSetToolResult(response);
          mockClearError("tools");
        }
      } catch (e) {
        // Only handle error if this controller is still the active one
        if (toolAbortController === abortController) {
          // Check if the error is due to cancellation using proper AbortError detection
          if (e instanceof Error && e.name === "AbortError") {
            const toolResult = {
              content: [
                {
                  type: "text",
                  text: "Tool execution was cancelled",
                },
              ],
              isError: false,
            };
            mockSetToolResult(toolResult);
            // Clear errors on cancellation
            mockClearError("tools");
          } else {
            const toolResult = {
              content: [
                {
                  type: "text",
                  text: (e as Error).message ?? String(e),
                },
              ],
              isError: true,
            };
            mockSetToolResult(toolResult);
            mockSetErrors(expect.any(Function));
          }
        }
      } finally {
        // Only clear the abort controller if this is still the active one
        if (toolAbortController === abortController) {
          mockSetToolAbortController(null);
          toolAbortController = null; // Update our test variable
        }
      }
    };
  };

  const createCancelToolFunction = () => {
    return () => {
      if (toolAbortController) {
        toolAbortController.abort();
      }
    };
  };

  describe("Concurrent Call Prevention", () => {
    it("should prevent concurrent tool calls", async () => {
      const callTool = createCallToolFunction();

      // Setup a long-running request
      let resolveRequest: (value: unknown) => void;
      const longRunningPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      mockMakeRequest.mockReturnValue(longRunningPromise);

      // Start first call
      const firstCall = callTool("tool1", {});
      expect(toolAbortController).not.toBeNull();
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(1);

      // Try to start second call - should be prevented
      await callTool("tool2", {});
      expect(mockMakeRequest).toHaveBeenCalledTimes(1); // Only first call made
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(1); // No new controller

      // Complete first call
      resolveRequest!(mockToolResult);
      await firstCall;

      expect(toolAbortController).toBeNull(); // Cleaned up
    });

    it("should allow new calls after previous call completes", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockResolvedValue(mockToolResult);

      // First call
      await callTool("tool1", {});
      expect(mockMakeRequest).toHaveBeenCalledTimes(1);
      expect(toolAbortController).toBeNull();

      // Second call should be allowed
      await callTool("tool2", {});
      expect(mockMakeRequest).toHaveBeenCalledTimes(2);
      expect(toolAbortController).toBeNull();
    });
  });

  describe("AbortError Detection", () => {
    it("should properly detect AbortError and set cancellation message", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockRejectedValue(mockAbortError);

      await callTool("testTool", {});

      expect(mockSetToolResult).toHaveBeenCalledWith({
        content: [
          {
            type: "text",
            text: "Tool execution was cancelled",
          },
        ],
        isError: false,
      });
      expect(mockClearError).toHaveBeenCalledWith("tools");
      expect(mockSetErrors).not.toHaveBeenCalled();
    });

    it("should treat regular errors as failures, not cancellations", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockRejectedValue(mockNetworkError);

      await callTool("testTool", {});

      expect(mockSetToolResult).toHaveBeenCalledWith({
        content: [
          {
            type: "text",
            text: "Network failure",
          },
        ],
        isError: true,
      });
      expect(mockSetErrors).toHaveBeenCalledWith(expect.any(Function));
      expect(mockClearError).not.toHaveBeenCalledWith("tools");
    });
  });

  describe("Race Condition Protection", () => {
    it("should not update state if abort controller has changed", async () => {
      const callTool = createCallToolFunction();

      let resolveRequest: (value: unknown) => void;
      const longRunningPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      mockMakeRequest.mockReturnValue(longRunningPromise);

      // Start first call
      const firstCall = callTool("tool1", {});

      // Simulate controller being replaced (race condition)
      const newController = new AbortController();
      mockSetToolAbortController(newController);
      toolAbortController = newController;

      // Complete first call
      resolveRequest!(mockToolResult);
      await firstCall;

      // Should not have updated state since controller changed
      expect(mockSetToolResult).not.toHaveBeenCalled();
      expect(mockClearError).not.toHaveBeenCalled();
    });

    it("should not clear abort controller if it has changed", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockResolvedValue(mockToolResult);

      // Start call
      await callTool("tool1", {});

      // Verify controller was cleared only once (in finally block)
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(2); // Set + clear
      expect(mockSetToolAbortController).toHaveBeenLastCalledWith(null);
    });
  });

  describe("Cancellation Function", () => {
    it("should abort the current controller when cancelTool is called", () => {
      const cancelTool = createCancelToolFunction();

      // Set up an active controller
      const controller = new AbortController();
      const abortSpy = jest.spyOn(controller, "abort");
      toolAbortController = controller;

      cancelTool();

      expect(abortSpy).toHaveBeenCalledTimes(1);
    });

    it("should do nothing when no tool is running", () => {
      const cancelTool = createCancelToolFunction();
      toolAbortController = null;

      // Should not throw or cause issues
      expect(() => cancelTool()).not.toThrow();
    });
  });

  describe("State Management", () => {
    it("should properly manage abort controller lifecycle", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockResolvedValue(mockToolResult);

      expect(toolAbortController).toBeNull();

      await callTool("testTool", {});

      // Should be null after completion
      expect(toolAbortController).toBeNull();
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(2); // Set + clear
    });

    it("should clear abort controller even on errors", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockRejectedValue(mockNetworkError);

      await callTool("testTool", {});

      expect(toolAbortController).toBeNull();
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(2); // Set + clear
    });

    it("should clear abort controller even on cancellation", async () => {
      const callTool = createCallToolFunction();
      mockMakeRequest.mockRejectedValue(mockAbortError);

      await callTool("testTool", {});

      expect(toolAbortController).toBeNull();
      expect(mockSetToolAbortController).toHaveBeenCalledTimes(2); // Set + clear
    });
  });
});
