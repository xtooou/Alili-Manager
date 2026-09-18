import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { createMenuItem, createDropIndicator } from "./loras_widget_components.js";
import { parseLoraValue, formatLoraValue, syncClipStrengthIfCollapsed, saveRecipeDirectly, copyToClipboard, showToast, moveLoraByDirection, getDropTargetIndex } from "./loras_widget_utils.js";

// Function to handle strength adjustment via dragging
export function handleStrengthDrag(name, initialStrength, initialX, event, widget, isClipStrength = false, updateWidget = true) {
  // Calculate drag sensitivity (how much the strength changes per pixel)
  // Using 0.01 per 10 pixels of movement
  const sensitivity = 0.001;
  
  // Get the current mouse position
  const currentX = event.clientX;
  
  // Calculate the distance moved
  const deltaX = currentX - initialX;
  
  // Calculate the new strength value based on movement
  // Moving right increases, moving left decreases
  let newStrength = Number(initialStrength) + (deltaX * sensitivity);
  
  // Limit the strength to reasonable bounds (now between -10 and 10)
  newStrength = Math.max(-10, Math.min(10, newStrength));
  newStrength = Number(newStrength.toFixed(2));
  
  // Update the lora data
  const lorasData = parseLoraValue(widget.value);
  const loraIndex = lorasData.findIndex(l => l.name === name);
  
  if (loraIndex >= 0) {
    // Update the appropriate strength property based on isClipStrength flag
    if (isClipStrength) {
      lorasData[loraIndex].clipStrength = newStrength;
    } else {
      lorasData[loraIndex].strength = newStrength;
      // Sync clipStrength if collapsed
      syncClipStrengthIfCollapsed(lorasData[loraIndex]);
    }
    
    // Always write back to widget.value to persist the mutation.
    // During drag (updateWidget=false), setValue skips renderLoras via __dragActive flag,
    // so the DOM survives and pointer capture is preserved.
    widget.value = formatLoraValue(lorasData);
    
    // Only fire callback on the final commit, not during drag
    if (updateWidget && widget.callback) {
      widget.callback(widget.value);
    }
  }
  
  return newStrength;
}

// Function to handle proportional strength adjustment for all LoRAs via header dragging
export function handleAllStrengthsDrag(initialStrengths, initialX, event, widget, updateWidget = true) {
  // Define sensitivity (less sensitive than individual adjustment)
  const sensitivity = 0.0005;
  
  // Get current mouse position
  const currentX = event.clientX;
  
  // Calculate the distance moved
  const deltaX = currentX - initialX;
  
  // Calculate adjustment factor (1.0 means no change, >1.0 means increase, <1.0 means decrease)
  // For positive deltaX, we want to increase strengths, for negative we want to decrease
  const adjustmentFactor = 1.0 + (deltaX * sensitivity);
  
  // Ensure adjustment factor is reasonable (prevent extreme changes)
  const limitedFactor = Math.max(0.01, Math.min(3.0, adjustmentFactor));
  
  // Get current loras data
  const lorasData = parseLoraValue(widget.value);
  
  // Apply the adjustment factor to each LoRA's strengths
  lorasData.forEach((loraData, index) => {
    // Get initial strengths for this LoRA
    const initialModelStrength = initialStrengths[index].modelStrength;
    const initialClipStrength = initialStrengths[index].clipStrength;
    
    // Apply the adjustment factor to both strengths
    let newModelStrength = (initialModelStrength * limitedFactor).toFixed(2);
    let newClipStrength = (initialClipStrength * limitedFactor).toFixed(2);
    
    // Limit the values to reasonable bounds (-10 to 10)
    newModelStrength = Math.max(-10, Math.min(10, newModelStrength));
    newClipStrength = Math.max(-10, Math.min(10, newClipStrength));
    
    // Update strengths
    lorasData[index].strength = Number(newModelStrength);
    lorasData[index].clipStrength = Number(newClipStrength);
  });
  
  // Always write back to widget.value to persist mutations.
  // During drag (updateWidget=false), setValue skips renderLoras via __dragActive flag.
  widget.value = formatLoraValue(lorasData);
  
  // Only fire callback on the final commit, not during drag
  if (updateWidget && widget.callback) {
    widget.callback(widget.value);
  }
}

// Function to initialize drag operation
export function initDrag(
  dragEl,
  name,
  widget,
  isClipStrength = false,
  previewTooltip,
  renderFunction,
  dragCallbacks = {}
) {
  let isDragging = false;
  let activePointerId = null;
  let initialX = 0;
  let initialStrength = 0;
  let currentDragElement = null;
  let hasMoved = false;
  const { onDragStart, onDragEnd } = dragCallbacks;
  
  // Create a drag handler using pointer events for Vue DOM render mode compatibility
  dragEl.addEventListener('pointerdown', (e) => {
    // Skip if clicking on toggle or strength control areas
    if (e.target.closest('.lm-lora-toggle') ||
        e.target.closest('input') ||
        e.target.closest('.lm-lora-arrow') ||
        e.target.closest('.lm-lora-drag-handle') ||
        e.target.closest('.lm-lora-lock-button') ||
        e.target.closest('.lm-lora-expand-button')) {
      return;
    }

    // Only handle left mouse button (allow middle button for canvas drag, right button for context menu)
    if (e.button !== 0) {
      return;
    }

    // Store initial values
    const lorasData = parseLoraValue(widget.value);
    const loraData = lorasData.find(l => l.name === name);
    
    if (!loraData) return;
    
    initialX = e.clientX;
    initialStrength = isClipStrength ? loraData.clipStrength : loraData.strength;
    isDragging = true;
    hasMoved = false;
    activePointerId = e.pointerId;
    currentDragElement = e.currentTarget;

    // Suppress renderLoras in setValue during drag so the DOM survives.
    // The getter creates a new array on every read, so mutations to a
    // parsed copy are lost unless we write back through widget.value.
    // Writing back would normally trigger a full DOM re-render via setValue,
    // destroying pointer capture. __dragActive tells setValue to skip the render.
    widget.__dragActive = true;

    // Capture pointer to receive all subsequent events regardless of stopPropagation
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    // Prevent text selection
    e.preventDefault();
  });
  
  dragEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    // Track if pointer moved significantly (more than 3 pixels)
    if (Math.abs(e.clientX - initialX) > 3) {
      hasMoved = true;
    }

    // Only stop propagation if we've started dragging (moved beyond threshold)
    if (hasMoved) {
      e.stopPropagation();
    }
    
    // Only process drag if we've moved beyond threshold
    if (!hasMoved) return;

    // Add class to body to enforce cursor style globally only after drag starts
    document.body.classList.add('lm-lora-strength-dragging');

    if (typeof onDragStart === 'function') {
      onDragStart();
    }

    // Call the strength adjustment function without updating widget.value during drag
    const newStrength = handleStrengthDrag(name, initialStrength, initialX, e, widget, isClipStrength, false);
    
    // Update strength input directly instead of re-rendering to avoid losing event listeners
    const strengthInput = currentDragElement.querySelector('.lm-lora-strength-input');
    if (strengthInput && typeof newStrength === 'number') {
      strengthInput.value = newStrength.toFixed(2);
    }
    
    // Prevent showing the preview tooltip during drag
    if (previewTooltip) {
      previewTooltip.hide();
    }
  });
  
  const endDrag = (e) => {
    if (!isDragging) return;

    // Only stop propagation if we actually dragged
    if (hasMoved) {
      e.stopPropagation();
    }

    // Release pointer capture if still have the element
    if (currentDragElement && activePointerId !== null) {
      try {
        currentDragElement.releasePointerCapture(activePointerId);
      } catch (err) {
        // Ignore errors if element is no longer in DOM
      }
    }

    const wasDragging = hasMoved;
    isDragging = false;
    hasMoved = false;
    activePointerId = null;
    currentDragElement = null;

    // Remove the class to restore normal cursor behavior
    document.body.classList.remove('lm-lora-strength-dragging');

    // Only call onDragEnd and re-render if we actually dragged.
    // try-finally guarantees __dragActive is always cleared, preventing a
    // permanent UI freeze if onDragEnd or setValue throws during cleanup.
    try {
      if (wasDragging) {
        if (typeof onDragEnd === 'function') {
          onDragEnd();
        }

        // Re-enable renderLoras in setValue and flush final value through setter.
        // The last handleStrengthDrag call already wrote the final strength to
        // widgetValue via setValue (with render suppressed). widget.value = widget.value
        // triggers setValue again, which now calls renderLoras since __dragActive is false.
        widget.__dragActive = false;
        widget.value = widget.value;
        if (typeof widget.callback === 'function') {
          widget.callback(widget.value);
        }
      }
    } finally {
      widget.__dragActive = false;
    }
  };

  dragEl.addEventListener('pointerup', endDrag);
  dragEl.addEventListener('pointercancel', endDrag);
}

// Function to initialize header drag for proportional strength adjustment
export function initHeaderDrag(headerEl, widget, renderFunction) {
  let isDragging = false;
  let activePointerId = null;
  let initialX = 0;
  let initialStrengths = [];
  let currentHeaderElement = null;
  let hasMoved = false;
  
  // Add cursor style to indicate draggable
  // Create a drag handler using pointer events for Vue DOM render mode compatibility
  headerEl.addEventListener('pointerdown', (e) => {
    // Skip if clicking on toggle or other interactive elements
    if (e.target.closest('.lm-lora-toggle') ||
        e.target.closest('input')) {
      return;
    }

    // Only handle left mouse button (allow middle button for canvas drag, right button for context menu)
    if (e.button !== 0) {
      return;
    }

    // Store initial X position
    initialX = e.clientX;
    
    // Store initial strengths of all LoRAs
    const lorasData = parseLoraValue(widget.value);
    initialStrengths = lorasData.map(lora => ({
      modelStrength: Number(lora.strength),
      clipStrength: Number(lora.clipStrength)
    }));
    
    isDragging = true;
    hasMoved = false;
    activePointerId = e.pointerId;
    currentHeaderElement = e.currentTarget;

    // Suppress renderLoras in setValue during drag (see initDrag for rationale)
    widget.__dragActive = true;

    // Capture pointer to receive all subsequent events regardless of stopPropagation
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    
    // Prevent text selection
    e.preventDefault();
  });
  
  // Handle pointer move for dragging
  headerEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    // Track if pointer moved significantly (more than 3 pixels)
    if (Math.abs(e.clientX - initialX) > 3) {
      hasMoved = true;
    }

    // Only stop propagation if we've started dragging (moved beyond threshold)
    if (hasMoved) {
      e.stopPropagation();
    }

    // Only process drag if we've moved beyond threshold
    if (!hasMoved) return;

    // Add class to body to enforce cursor style globally only after drag starts
    document.body.classList.add('lm-lora-strength-dragging');

    // Call the strength adjustment function without updating widget.value during drag
    handleAllStrengthsDrag(initialStrengths, initialX, e, widget, false);
    
    // Update strength inputs directly instead of re-rendering to avoid losing event listeners
    const strengthInputs = currentHeaderElement.parentElement.querySelectorAll('.lm-lora-strength-input');
    const lorasData = parseLoraValue(widget.value);
    strengthInputs.forEach((input, index) => {
      if (lorasData[index]) {
        input.value = lorasData[index].strength.toFixed(2);
      }
    });
  });
  
  const endDrag = (e) => {
    if (!isDragging) return;

    // Only stop propagation if we actually dragged
    if (hasMoved) {
      e.stopPropagation();
    }

    // Release pointer capture if still have the element
    if (currentHeaderElement && activePointerId !== null) {
      try {
        currentHeaderElement.releasePointerCapture(activePointerId);
      } catch (err) {
        // Ignore errors if element is no longer in DOM
      }
    }

    const wasDragging = hasMoved;
    isDragging = false;
    hasMoved = false;
    activePointerId = null;
    currentHeaderElement = null;
    
    // Remove the class to restore normal cursor behavior
    document.body.classList.remove('lm-lora-strength-dragging');

    // Only re-render if we actually dragged.
    // try-finally guarantees __dragActive is always cleared, preventing a
    // permanent UI freeze if setValue throws during cleanup.
    try {
      if (wasDragging) {
        // Re-enable renderLoras in setValue and flush final value through setter
        widget.__dragActive = false;
        widget.value = widget.value;
        if (typeof widget.callback === 'function') {
          widget.callback(widget.value);
        }
      }
    } finally {
      widget.__dragActive = false;
    }
  };

  // Handle pointer up to end dragging
  headerEl.addEventListener('pointerup', endDrag);
  
  // Handle pointer cancel to end dragging
  headerEl.addEventListener('pointercancel', endDrag);
}

// Function to initialize drag-and-drop for reordering
export function initReorderDrag(dragHandle, loraName, widget, renderFunction) {
  let isDragging = false;
  let activePointerId = null;
  let draggedElement = null;
  let dropIndicator = null;
  let container = null;
  let scale = 1;
  let hasMoved = false;
  
  dragHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    
    isDragging = true;
    hasMoved = false;
    activePointerId = e.pointerId;
    draggedElement = dragHandle.closest('.lm-lora-entry');
    container = draggedElement.parentElement;
    
    // Capture pointer to receive all subsequent events regardless of stopPropagation
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!isDragging || !draggedElement) return;

    // Track if pointer moved significantly (more than 3 pixels vertically)
    if (Math.abs(e.movementY) > 3) {
      hasMoved = true;
    }

    // Only stop propagation and process drag if we've moved beyond threshold
    if (!hasMoved) return;

    // Stop propagation and start drag visuals
    e.stopPropagation();

    // Add dragging class and visual feedback only after drag starts
    if (!dropIndicator) {
      draggedElement.classList.add('lm-lora-entry--dragging');

      // Create single drop indicator with absolute positioning
      dropIndicator = createDropIndicator();
      
      // Make container relatively positioned for absolute indicator
      const originalPosition = container.style.position;
      container.style.position = 'relative';
      container.appendChild(dropIndicator);
      
      // Store original position for cleanup
      container._originalPosition = originalPosition;
      
      // Add global cursor style
      document.body.classList.add('lm-lora-reordering');

      // Store workflow scale for accurate positioning
      scale = app.canvas.ds.scale;
    }
    
    const targetIndex = getDropTargetIndex(container, e.clientY);
    const entries = container.querySelectorAll('.lm-lora-entry, .lm-lora-clip-entry');
    
    if (targetIndex === 0) {
      // Show at top
      const firstEntry = entries[0];
      if (firstEntry) {
        const rect = firstEntry.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        // Convert GBCR visual offset to container-local space (rect/containerRect are post-scale,
        // scrollTop is pre-scale), so only the visual-diff portion is divided by scale
        dropIndicator.style.top = `${(rect.top - containerRect.top) / scale + container.scrollTop - 2}px`;
        dropIndicator.style.opacity = '1';
      }
    } else if (targetIndex < entries.length) {
      // Show between entries
      const targetEntry = entries[targetIndex];
      if (targetEntry) {
        const rect = targetEntry.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        dropIndicator.style.top = `${(rect.top - containerRect.top) / scale + container.scrollTop - 2}px`;
        dropIndicator.style.opacity = '1';
      }
    } else {
      // Show at bottom
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const rect = lastEntry.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        dropIndicator.style.top = `${(rect.bottom - containerRect.top) / scale + container.scrollTop + 2}px`;
        dropIndicator.style.opacity = '1';
      }
    }
  });
  
  dragHandle.addEventListener('pointerup', (e) => {
    // Only stop propagation if we actually dragged
    if (hasMoved) {
      e.stopPropagation();
    }

    // Always reset cursor regardless of isDragging state
    document.body.classList.remove('lm-lora-reordering');

    if (!isDragging || !draggedElement) {
      // Release pointer capture even if not dragging
      const target = e.currentTarget;
      if (activePointerId !== null) {
        target.releasePointerCapture(activePointerId);
      }
      isDragging = false;
      hasMoved = false;
      activePointerId = null;
      return;
    }

    // Release pointer capture
    const target = e.currentTarget;
    if (activePointerId !== null) {
      target.releasePointerCapture(activePointerId);
    }

    const wasDragging = hasMoved;
    isDragging = false;
    hasMoved = false;
    activePointerId = null;

    // Only process reordering if we actually dragged
    if (wasDragging) {
      const targetIndex = getDropTargetIndex(container, e.clientY);

      // Get current LoRA data
      const lorasData = parseLoraValue(widget.value);
      const currentIndex = lorasData.findIndex(l => l.name === loraName);

      if (currentIndex !== -1 && currentIndex !== targetIndex) {
        // Calculate actual target index (excluding clip entries from count)
        const loraEntries = container.querySelectorAll('.lm-lora-entry');
        let actualTargetIndex = targetIndex;

        // Adjust target index if it's beyond the number of actual LoRA entries
        if (actualTargetIndex > loraEntries.length) {
          actualTargetIndex = loraEntries.length;
        }

        // Move the LoRA
        const newLoras = [...lorasData];
        const [moved] = newLoras.splice(currentIndex, 1);
        newLoras.splice(actualTargetIndex > currentIndex ? actualTargetIndex - 1 : actualTargetIndex, 0, moved);

        widget.value = formatLoraValue(newLoras);

        if (widget.callback) {
          widget.callback(widget.value);
        }

        // Re-render
        if (renderFunction) {
          renderFunction(widget.value, widget);
        }
      }
    }

    // Cleanup
    if (draggedElement) {
      draggedElement.classList.remove('lm-lora-entry--dragging');
      draggedElement = null;
    }

    if (dropIndicator && container) {
      container.removeChild(dropIndicator);
      // Restore original position
      container.style.position = container._originalPosition || '';
      delete container._originalPosition;
      dropIndicator = null;
    }

    container = null;
  });

  dragHandle.addEventListener('pointercancel', (e) => {
    // Only stop propagation if we actually dragged
    if (hasMoved) {
      e.stopPropagation();
    }

    // Always reset cursor regardless of isDragging state
    document.body.classList.remove('lm-lora-reordering');

    if (!isDragging || !draggedElement) {
      // Release pointer capture even if not dragging
      const target = e.currentTarget;
      if (activePointerId !== null) {
        target.releasePointerCapture(activePointerId);
      }
      isDragging = false;
      hasMoved = false;
      activePointerId = null;
      return;
    }

    // Release pointer capture
    const target = e.currentTarget;
    if (activePointerId !== null) {
      target.releasePointerCapture(activePointerId);
    }

    isDragging = false;
    hasMoved = false;
    activePointerId = null;

    // Cleanup without reordering
    if (draggedElement) {
      draggedElement.classList.remove('lm-lora-entry--dragging');
      draggedElement = null;
    }

    if (dropIndicator && container) {
      container.removeChild(dropIndicator);
      // Restore original position
      container.style.position = container._originalPosition || '';
      delete container._originalPosition;
      dropIndicator = null;
    }

    container = null;
  });
}

// Function to handle keyboard navigation
export function handleKeyboardNavigation(event, selectedLora, widget, renderFunction, selectLora) {
  if (!selectedLora) return false;

  const lorasData = parseLoraValue(widget.value);
  let handled = false;
  const isStrengthInputFocused =
    event?.target?.classList?.contains('lm-lora-strength-input') ?? false;
  
  // Check for Ctrl/Cmd modifier for reordering
  if (event.ctrlKey || event.metaKey) {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        const newLorasUp = moveLoraByDirection(lorasData, selectedLora, 'up');
        widget.value = formatLoraValue(newLorasUp);
        if (widget.callback) widget.callback(widget.value);
        if (renderFunction) renderFunction(widget.value, widget);
        handled = true;
        break;
        
      case 'ArrowDown':
        event.preventDefault();
        const newLorasDown = moveLoraByDirection(lorasData, selectedLora, 'down');
        widget.value = formatLoraValue(newLorasDown);
        if (widget.callback) widget.callback(widget.value);
        if (renderFunction) renderFunction(widget.value, widget);
        handled = true;
        break;
        
      case 'Home':
        event.preventDefault();
        const newLorasTop = moveLoraByDirection(lorasData, selectedLora, 'top');
        widget.value = formatLoraValue(newLorasTop);
        if (widget.callback) widget.callback(widget.value);
        if (renderFunction) renderFunction(widget.value, widget);
        handled = true;
        break;
        
      case 'End':
        event.preventDefault();
        const newLorasBottom = moveLoraByDirection(lorasData, selectedLora, 'bottom');
        widget.value = formatLoraValue(newLorasBottom);
        if (widget.callback) widget.callback(widget.value);
        if (renderFunction) renderFunction(widget.value, widget);
        handled = true;
        break;
    }
  } else {
    // Normal navigation without Ctrl/Cmd
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        const currentIndex = lorasData.findIndex(l => l.name === selectedLora);
        if (currentIndex > 0) {
          selectLora(lorasData[currentIndex - 1].name);
        }
        handled = true;
        break;
        
      case 'ArrowDown':
        event.preventDefault();
        const currentIndexDown = lorasData.findIndex(l => l.name === selectedLora);
        if (currentIndexDown < lorasData.length - 1) {
          selectLora(lorasData[currentIndexDown + 1].name);
        }
        handled = true;
        break;
        
      case 'Delete':
      case 'Backspace':
        if (isStrengthInputFocused) {
          break;
        }
        event.preventDefault();
        const filtered = lorasData.filter(l => l.name !== selectedLora);
        widget.value = formatLoraValue(filtered);
        if (widget.callback) widget.callback(widget.value);
        if (renderFunction) renderFunction(widget.value, widget);
        selectLora(null); // Clear selection
        handled = true;
        break;
    }
  }
  
  return handled;
}

// Function to create context menu
export function createContextMenu(x, y, loraName, widget, previewTooltip, renderFunction) {
  if (previewTooltip) {
    previewTooltip.hide();
  }

  const existingMenu = document.querySelector('.lm-lora-context-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  const menu = document.createElement('div');
  menu.className = 'lm-lora-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.visibility = 'hidden';

  const isCkpt = widget.__activeTab === 'ckpt';
  const apiType = isCkpt ? 'checkpoints' : 'loras';

// 🎯 核心逻辑：自动提取画布上最新生成的图像文件 (File)
  const getLatestGeneratedImageFile = async () => {
// 1. 严格锁定【保存图像】与【预览图像】，坚决排除【加载图像】等任何输入节点
    const imgNodes = app.graph?._nodes?.filter(n => {
      if (!Array.isArray(n.imgs) || n.imgs.length === 0) return false;
      const name = `${n.type || ''} ${n.comfyClass || ''} ${n.title || ''}`.toLowerCase();
      // 核心避坑：彻底排除加载图像 (LoadImage)
      if (name.includes('load') || name.includes('加载') || name.includes('input')) {
        return false;
      }
      // 只认保存或预览节点
      return name.includes('save') || name.includes('preview') || name.includes('保存') || name.includes('预览');
    }) || [];
    if (imgNodes.length > 0) {
      const lastNode = imgNodes[imgNodes.length - 1];
      const idx = (typeof lastNode.imageIndex === 'number' && lastNode.imageIndex >= 0)
        ? lastNode.imageIndex
        : (lastNode.imgs.length - 1);
      const imgEl = lastNode.imgs[idx];
      if (imgEl?.src) {
        try {
          const resp = await fetch(imgEl.src);
          if (resp.ok) {
            const blob = await resp.blob();
            return new File([blob], "preview.png", { type: blob.type || "image/png" });
          }
        } catch (e) {}
      }
    }

    // 2. 兜底：从最近一次运行的执行记录 (History) 中抓取生成图
    try {
      const historyData = await api.getHistory(1);
      const historyObj = historyData?.History || historyData || {};
      const promptIds = Object.keys(historyObj);
      if (promptIds.length > 0) {
        const latestPrompt = historyObj[promptIds[0]];
        const outputs = latestPrompt?.outputs || {};
        let foundImg = null;
        for (const nodeId of Object.keys(outputs)) {
          const out = outputs[nodeId];
          if (Array.isArray(out?.images) && out.images.length > 0) {
            foundImg = out.images[out.images.length - 1];
          }
        }
        if (foundImg?.filename) {
          const viewUrl = `/view?filename=${encodeURIComponent(foundImg.filename)}&subfolder=${encodeURIComponent(foundImg.subfolder || '')}&type=${encodeURIComponent(foundImg.type || 'output')}`;
          const resp = await fetch(viewUrl);
          if (resp.ok) {
            const blob = await resp.blob();
            return new File([blob], "preview.png", { type: blob.type || "image/png" });
          }
        }
      }
    } catch (e) {}

    return null;
  };

  // 统一的封面覆写执行器
  const executeSetPreview = async (file) => {
    showToast('正在更新模型封面...', 'info');
    let exactModelPath = loraName;
    const clean = loraName.replace(/\\/g, '/').toLowerCase();
    const pure = clean.split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');

    try {
      const res = await (window.comfyAPI?.api?.fetchApi || fetch)(`/api/lm/${apiType}/list?page=1&page_size=2000`);
      const json = await res.json();
      const list = json.items || json.models || (Array.isArray(json) ? json : []);
      const target = list.find(m => {
        const mFile = (m.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
        const mPath = (m.file_path || '').replace(/\\/g, '/').toLowerCase();
        return mFile === pure || mPath.endsWith(clean);
      });
      if (target?.file_path) {
        exactModelPath = target.file_path;
      }
    } catch (e) {}

    const formData = new FormData();
    formData.append('preview_file', file);
    formData.append('model_path', exactModelPath);
    formData.append('nsfw_level', '0');

    const uploadRes = await fetch(`/api/lm/${apiType}/replace-preview`, {
      method: 'POST',
      body: formData
    });

    if (!uploadRes.ok) throw new Error();

    const newTimestamp = Date.now();
    const storageKeys = [
      `lora_manager_${apiType}_preview_versions`,
      `lora_manager_${isCkpt ? 'checkpoint' : 'lora'}_preview_versions`
    ];

    storageKeys.forEach(storageKey => {
      try {
        const raw = localStorage.getItem(storageKey);
        let entries = [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            entries = Array.isArray(parsed) ? parsed : Object.entries(parsed);
          } catch (err) {}
        }
        const map = new Map(entries);
        map.set(exactModelPath, newTimestamp);
        map.set(exactModelPath.replace(/\\/g, '/'), newTimestamp);
        map.set(exactModelPath.replace(/\//g, '\\'), newTimestamp);
        localStorage.setItem(storageKey, JSON.stringify(Array.from(map.entries())));
      } catch (e) {}
    });

    showToast('已成功将生图设为封面！', 'success');
    if (renderFunction) {
      renderFunction(widget.value, widget);
    }
  };

  // 设生图为封面菜单项
  const saveAsCoverOption = createMenuItem(
    '设生图为封面',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    async () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      try {
        showToast('正在提取最新生图...', 'info');
        const file = await getLatestGeneratedImageFile();
        if (!file) {
          showToast('未检测到最新生图，请先生成一张图像', 'warning');
          return;
        }
        await executeSetPreview(file);
      } catch (err) {
        showToast('设为封面失败', 'error');
      }
    }
  );  

  // 1. 上传封面（动态识别 LoRA / Checkpoint 路径与类型）
  const uploadPreviewOption = createMenuItem(
    '上传封面',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
    () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,image/webp,video/mp4';

      input.onchange = async () => {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];

        try {
          showToast('正在上传封面...', 'info');

          let exactModelPath = loraName;
          const clean = loraName.replace(/\\/g, '/').toLowerCase();
          const pure = clean.split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');

          try {
            const res = await (window.comfyAPI?.api?.fetchApi || fetch)(`/api/lm/${apiType}/list?page=1&page_size=2000`);
            const json = await res.json();
            const list = json.items || json.models || (Array.isArray(json) ? json : []);
            const target = list.find(m => {
              const mFile = (m.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
              const mPath = (m.file_path || '').replace(/\\/g, '/').toLowerCase();
              return mFile === pure || mPath.endsWith(clean);
            });
            if (target?.file_path) {
              exactModelPath = target.file_path;
            }
          } catch (e) {}

          const formData = new FormData();
          formData.append('preview_file', file);
          formData.append('model_path', exactModelPath);
          formData.append('nsfw_level', '0');

          const uploadRes = await fetch(`/api/lm/${apiType}/replace-preview`, {
            method: 'POST',
            body: formData
          });

          if (!uploadRes.ok) throw new Error();

          const newTimestamp = Date.now();
          const storageKeys = [
            `lora_manager_${apiType}_preview_versions`,
            `lora_manager_${isCkpt ? 'checkpoint' : 'lora'}_preview_versions`
          ];

          storageKeys.forEach(storageKey => {
            try {
              const raw = localStorage.getItem(storageKey);
              let entries = [];
              if (raw) {
                try {
                  const parsed = JSON.parse(raw);
                  entries = Array.isArray(parsed) ? parsed : Object.entries(parsed);
                } catch (err) {}
              }
              const map = new Map(entries);
              map.set(exactModelPath, newTimestamp);
              map.set(exactModelPath.replace(/\\/g, '/'), newTimestamp);
              map.set(exactModelPath.replace(/\//g, '\\'), newTimestamp);
              localStorage.setItem(storageKey, JSON.stringify(Array.from(map.entries())));
            } catch (e) {}
          });

          showToast('封面上传成功', 'success');

          if (renderFunction) {
            renderFunction(widget.value, widget);
          }
        } catch (err) {
          showToast('封面上传失败', 'error');
        }
      };

      input.click();
    }
  );

  // 2. Civitai 查看（动态匹配两端接口与模型元数据）
  const viewOnCivitaiOption = createMenuItem(
    'Civitai 查看',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    async () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      try {
        let civitaiUrl = '';
        if (isCkpt) {
          const res = await (window.comfyAPI?.api?.fetchApi || fetch)('/api/lm/checkpoints/list?page=1&page_size=2000');
          const json = await res.json();
          const list = json.items || json.models || (Array.isArray(json) ? json : []);
          const clean = loraName.replace(/\\/g, '/').toLowerCase();
          const pure = clean.split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
          const m = list.find(item => {
            const f = (item.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
            const p = (item.file_path || '').replace(/\\/g, '/').toLowerCase();
            return f === pure || p.endsWith(clean);
          });
          const modelId = m?.civitai?.modelId || m?.civitai?.id;
          if (modelId) civitaiUrl = `https://civitai.com/models/${modelId}`;
        } else {
          const response = await api.fetchApi(`/lm/loras/civitai-url?name=${encodeURIComponent(loraName)}`, { method: 'GET' });
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.civitai_url) civitaiUrl = data.civitai_url;
          }
        }

        if (civitaiUrl) {
          window.open(civitaiUrl, '_blank');
        } else {
          showToast('该模型没有关联的 Civitai 地址', 'warning');
        }
      } catch (error) {
        showToast('获取 Civitai 地址失败', 'error');
      }
    }
  );

  // 3. 复制触发词
  const copyTriggerWordsOption = createMenuItem(
    '复制触发词',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>',
    async () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      try {
        const response = await api.fetchApi(`/lm/loras/get-trigger-words?name=${encodeURIComponent(loraName)}`, { method: 'GET' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.success && data.trigger_words?.length > 0) {
          await copyToClipboard(data.trigger_words.join(', '), '触发词已复制到剪贴板');
        } else {
          showToast('该 LoRA 暂无触发词', 'info');
        }
      } catch (error) {
        showToast('获取触发词失败', 'error');
      }
    }
  );

  // 4. 复制提示词（附加备注内容）
  const copyNotesOption = createMenuItem(
    '复制提示词',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
    async () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      try {
        let notes = '';
        if (isCkpt) {
          const res = await (window.comfyAPI?.api?.fetchApi || fetch)('/api/lm/checkpoints/list?page=1&page_size=2000');
          const json = await res.json();
          const list = json.items || json.models || (Array.isArray(json) ? json : []);
          const clean = loraName.replace(/\\/g, '/').toLowerCase();
          const pure = clean.split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
          const m = list.find(item => {
            const f = (item.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
            const p = (item.file_path || '').replace(/\\/g, '/').toLowerCase();
            return f === pure || p.endsWith(clean);
          });
          notes = m?.notes || '';
        } else {
          const response = await api.fetchApi(`/lm/loras/get-notes?name=${encodeURIComponent(loraName)}`, { method: 'GET' });
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.notes?.trim()) notes = data.notes;
          }
        }

        if (notes && notes.trim()) {
          await copyToClipboard(notes.trim(), '附加备注已复制到剪贴板');
        } else {
          showToast('该模型暂无附加备注', 'info');
        }
      } catch (error) {
        showToast('获取附加备注失败', 'error');
      }
    }
  );

  // 5. 保存为样本
  const saveOption = createMenuItem(
    '保存为样本',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>',
    () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      saveRecipeDirectly();
    }
  );

// 6. 移除（兼容 LoRA 与 大模型语法删除）
  const deleteOption = createMenuItem(
    '移除', 
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>',
    () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      if (widget.__activeTab === 'ckpt') {
        const inputWidget = widget.node?.inputWidget || widget.node?.widgets?.find(w => w.name === 'text');
        if (inputWidget) {
          const regex = new RegExp(`<model:${loraName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::[^>]+)?>\\s*`, 'gi');
          inputWidget.value = (inputWidget.value || '').replace(regex, '').trim();
          if (typeof inputWidget.callback === 'function') inputWidget.callback(inputWidget.value);
        }
      } else {
        const lorasData = parseLoraValue(widget.value).filter(l => l.name !== loraName);
        widget.value = formatLoraValue(lorasData);
        if (widget.callback) widget.callback(widget.value);
      }
      if (renderFunction) renderFunction(widget.value, widget);
    }
  );

  const separator1 = document.createElement('hr');
  const separator2 = document.createElement('hr');

  menu.appendChild(uploadPreviewOption);
  menu.appendChild(saveAsCoverOption);
  menu.appendChild(viewOnCivitaiOption);
  if (widget.__activeTab !== 'ckpt') menu.appendChild(copyTriggerWordsOption); // 👈 一行代码屏蔽大模型触发词
  menu.appendChild(copyNotesOption);
  menu.appendChild(separator1);
  menu.appendChild(saveOption);
  menu.appendChild(separator2);
  menu.appendChild(deleteOption);
  
  document.body.appendChild(menu);

  const VIEWPORT_MARGIN = 8;
  const menuRect = menu.getBoundingClientRect();
  let menuLeft = x;
  let menuTop = y;
  if (menuLeft + menuRect.width > window.innerWidth - VIEWPORT_MARGIN) {
    menuLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - menuRect.width - VIEWPORT_MARGIN);
  }
  if (menuTop + menuRect.height > window.innerHeight - VIEWPORT_MARGIN) {
    menuTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - menuRect.height - VIEWPORT_MARGIN);
  }
  menu.style.left = `${menuLeft}px`;
  menu.style.top = `${menuTop}px`;
  menu.style.visibility = '';

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}
