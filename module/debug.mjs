/**
 * RMF System - Centralized Debug Utilities
 * 
 * Provides structured logging and debugging tools for the RMF system.
 * All debug output can be toggled via system settings and provides
 * consistent formatting across the entire system.
 * 
 * @fileoverview Centralized debugging and logging system
 * @version 1.0.0
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 */

/**
 * Centralized debugging and logging system for RMF
 * 
 * This class provides a unified interface for all debug logging throughout
 * the system. Debug output is controlled by the system setting "debugMode"
 * and provides consistent formatting and categorization.
 * 
 * @class RMFDebug
 * @example
 * // Basic logging
 * RMFDebug.log("ActorSheet", "Rendering character sheet", { actorId: "abc123" });
 * 
 * // Error logging
 * RMFDebug.error("DataModel", "Failed to validate actor data", error);
 * 
 * // Performance tracking
 * RMFDebug.time("Calculation");
 * // ... expensive operation ...
 * RMFDebug.timeEnd("Calculation");
 * 
 * // Tabular data
 * RMFDebug.table("Stats", [
 *   { name: "Agility", value: 75, bonus: 5 },
 *   { name: "Constitution", value: 80, bonus: 8 }
 * ]);
 */
export class RMFDebug {
  
  /**
   * Check if debug mode is currently enabled
   * 
   * @static
   * @readonly
   * @type {boolean}
   */
  static get enabled() {
    return CONFIG.RMF?.debug ?? false;
  }

  /**
   * Set debug mode state
   * 
   * @static
   * @param {boolean} value - Enable or disable debug mode
   */
  static set enabled(value) {
    if (!CONFIG.RMF) CONFIG.RMF = {};
    CONFIG.RMF.debug = Boolean(value);
  }

  /**
   * Log a debug message with optional data
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} message - The message to log
   * @param {*} [data] - Optional data to include in the log
   * 
   * @example
   * RMFDebug.log("ActorSheet", "Loading actor data", { actorId: actor.id });
   */
  static log(category, message, data = null) {
    if (!this.enabled) return;
    
    const prefix = `RMF DEBUG | ${category}`;
    
    if (data !== null && data !== undefined) {
      console.log(prefix, message, data);
    } else {
      console.log(prefix, message);
    }
  }

  /**
   * Log an informational message
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} message - The message to log
   * @param {*} [data] - Optional data to include in the log
   */
  static info(category, message, data = null) {
    const prefix = `RMF | ${category}`;
    
    if (data !== null && data !== undefined) {
      console.info(prefix, message, data);
    } else {
      console.info(prefix, message);
    }
  }

  /**
   * Log a warning message
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} message - The warning message
   * @param {*} [data] - Optional data to include in the log
   */
  static warn(category, message, data = null) {
    const prefix = `RMF WARNING | ${category}`;
    
    if (data !== null && data !== undefined) {
      console.warn(prefix, message, data);
    } else {
      console.warn(prefix, message);
    }
  }

  /**
   * Log an error message
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} message - The error message
   * @param {Error|*} [error] - Optional error object or data
   * 
   * @example
   * try {
   *   // ... operation ...
   * } catch (err) {
   *   RMFDebug.error("DataModel", "Failed to save actor", err);
   * }
   */
  static error(category, message, error = null) {
    const prefix = `RMF ERROR | ${category}`;
    
    if (error instanceof Error) {
      console.error(prefix, message, error);
      if (this.enabled && error.stack) {
        console.error(error.stack);
      }
    } else if (error !== null && error !== undefined) {
      console.error(prefix, message, error);
    } else {
      console.error(prefix, message);
    }
  }

  /**
   * Log a trace message with stack trace
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} message - The message to trace
   * 
   * @example
   * RMFDebug.trace("ActorSheet", "Unexpected code path reached");
   */
  static trace(category, message) {
    if (!this.enabled) return;
    
    console.trace(`RMF TRACE | ${category}`, message);
  }

  /**
   * Log tabular data for easy viewing
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {Array|Object} data - Data to display in table format
   * 
   * @example
   * RMFDebug.table("Skills", [
   *   { name: "Acrobatics", rank: 5, bonus: 15 },
   *   { name: "Athletics", rank: 3, bonus: 10 }
   * ]);
   */
  static table(category, data) {
    if (!this.enabled) return;
    
    console.log(`RMF TABLE | ${category}`);
    console.table(data);
  }

  /**
   * Start a performance timer
   * 
   * @static
   * @param {string} label - Unique label for the timer
   * 
   * @example
   * RMFDebug.time("CalculateStats");
   * // ... expensive operation ...
   * RMFDebug.timeEnd("CalculateStats");
   */
  static time(label) {
    if (!this.enabled) return;
    
    console.time(`RMF TIMER | ${label}`);
  }

  /**
   * End a performance timer and log the duration
   * 
   * @static
   * @param {string} label - Label matching the timer started with time()
   */
  static timeEnd(label) {
    if (!this.enabled) return;
    
    console.timeEnd(`RMF TIMER | ${label}`);
  }

  /**
   * Log the current value at a specific point in a timer
   * 
   * @static
   * @param {string} label - Label matching the timer started with time()
   * @param {string} [checkpoint] - Optional checkpoint description
   */
  static timeLog(label, checkpoint = "") {
    if (!this.enabled) return;
    
    const logLabel = checkpoint 
      ? `RMF TIMER | ${label} - ${checkpoint}`
      : `RMF TIMER | ${label}`;
      
    console.timeLog(logLabel);
  }

  /**
   * Create a grouped set of log messages
   * 
   * @static
   * @param {string} label - Group label
   * @param {Function} callback - Function that performs logging
   * @param {boolean} [collapsed=false] - Whether to start collapsed
   * 
   * @example
   * RMFDebug.group("Actor Preparation", () => {
   *   RMFDebug.log("Stats", "Calculating stat bonuses");
   *   RMFDebug.log("HP", "Calculating hit points");
   * });
   */
  static group(label, callback, collapsed = false) {
    if (!this.enabled) return;
    
    const groupLabel = `RMF | ${label}`;
    
    if (collapsed) {
      console.groupCollapsed(groupLabel);
    } else {
      console.group(groupLabel);
    }
    
    try {
      callback();
    } finally {
      console.groupEnd();
    }
  }

  /**
   * Assert a condition and log an error if it fails
   * 
   * @static
   * @param {boolean} condition - Condition to test
   * @param {string} category - Category or component name
   * @param {string} message - Message to log if assertion fails
   * 
   * @example
   * RMFDebug.assert(actor.system.chStats, "ActorData", "Actor missing stats");
   */
  static assert(condition, category, message) {
    if (condition) return;
    
    this.error(category, `Assertion failed: ${message}`);
    
    if (this.enabled) {
      console.trace();
    }
  }

  /**
   * Log object properties in a readable format
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} label - Label for the object
   * @param {Object} obj - Object to inspect
   * 
   * @example
   * RMFDebug.inspect("ActorData", "Character Stats", actor.system.chStats);
   */
  static inspect(category, label, obj) {
    if (!this.enabled) return;
    
    console.log(`RMF INSPECT | ${category} | ${label}`);
    console.dir(obj, { depth: 3 });
  }

  /**
   * Log the difference between two objects
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {Object} before - Original object
   * @param {Object} after - Modified object
   * @param {string} [label=""] - Optional label for the comparison
   * 
   * @example
   * RMFDebug.diff("ActorUpdate", oldData, newData, "Stats Changed");
   */
  static diff(category, before, after, label = "") {
    if (!this.enabled) return;
    
    const prefix = label 
      ? `RMF DIFF | ${category} | ${label}`
      : `RMF DIFF | ${category}`;
    
    console.log(prefix);
    console.log("Before:", before);
    console.log("After:", after);
    
    // Calculate differences
    const changes = {};
    for (const key in after) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = {
          before: before[key],
          after: after[key]
        };
      }
    }
    
    if (Object.keys(changes).length > 0) {
      console.table(changes);
    } else {
      console.log("No changes detected");
    }
  }

  /**
   * Create a visual separator in the console
   * 
   * @static
   * @param {string} [label=""] - Optional label for the separator
   */
  static separator(label = "") {
    if (!this.enabled) return;
    
    const line = "=".repeat(60);
    
    if (label) {
      console.log(`${line}\n${label}\n${line}`);
    } else {
      console.log(line);
    }
  }

  /**
   * Log the current call stack
   * 
   * @static
   * @param {string} category - Category or component name
   * @param {string} [message=""] - Optional message
   */
  static stack(category, message = "") {
    if (!this.enabled) return;
    
    const prefix = message
      ? `RMF STACK | ${category} | ${message}`
      : `RMF STACK | ${category}`;
    
    console.log(prefix);
    console.trace();
  }

  /**
   * Log memory usage information (if available)
   * 
   * @static
   */
  static memory() {
    if (!this.enabled) return;
    
    if (performance.memory) {
      const used = Math.round(performance.memory.usedJSHeapSize / 1048576);
      const total = Math.round(performance.memory.totalJSHeapSize / 1048576);
      const limit = Math.round(performance.memory.jsHeapSizeLimit / 1048576);
      
      console.log("RMF MEMORY |", {
        used: `${used} MB`,
        total: `${total} MB`,
        limit: `${limit} MB`,
        usage: `${Math.round((used / limit) * 100)}%`
      });
    } else {
      console.log("RMF MEMORY | Performance memory API not available");
    }
  }

  /**
   * Generate a performance report for common operations
   * 
   * @static
   * @returns {Object} Performance metrics
   */
  static getPerformanceReport() {
    if (!this.enabled) return null;
    
    const marks = performance.getEntriesByType("mark")
      .filter(mark => mark.name.startsWith("RMF"));
    
    const measures = performance.getEntriesByType("measure")
      .filter(measure => measure.name.startsWith("RMF"));
    
    return {
      marks: marks.map(m => ({ name: m.name, time: m.startTime })),
      measures: measures.map(m => ({ 
        name: m.name, 
        duration: m.duration,
        start: m.startTime 
      }))
    };
  }

  /**
   * Clear all debug timers and marks
   * 
   * @static
   */
  static clearPerformance() {
    performance.getEntriesByType("mark")
      .filter(mark => mark.name.startsWith("RMF"))
      .forEach(mark => performance.clearMarks(mark.name));
    
    performance.getEntriesByType("measure")
      .filter(measure => measure.name.startsWith("RMF"))
      .forEach(measure => performance.clearMeasures(measure.name));
    
    if (this.enabled) {
      console.log("RMF DEBUG | Performance data cleared");
    }
  }
}

/**
 * Global shorthand for RMFDebug (optional convenience)
 * Can be disabled by setting CONFIG.RMF.useDebugShorthand = false
 * 
 * @global
 * @type {RMFDebug}
 * @example
 * // Instead of:
 * RMFDebug.log("Component", "Message");
 * // You can use:
 * RMF_D.log("Component", "Message");
 */
globalThis.RMF_D = RMFDebug;
