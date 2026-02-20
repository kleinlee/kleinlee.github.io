// xs-components.js
// 版本: 1.0.0

(function() {
    'use strict';
    
    // 工具函数
    const _createElement = (tag, className, content) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (content) el.innerHTML = content;
        return el;
    };
    
    const _appendToBody = (element) => {
        document.body.appendChild(element);
    };
    
    const _removeFromBody = (element) => {
        if (element && element.parentNode) {
            document.body.removeChild(element);
        }
    };
    
    // 组件管理器
    const XSComponent = {
        // 创建遮罩层
        createOverlay: function() {
            const overlay = _createElement('div', 'xs-overlay');
            overlay.id = 'xs-overlay-' + Date.now();
            _appendToBody(overlay);
            return overlay;
        },
        
        // 创建模态框
        createModal: function(title, content, footer) {
            const modal = _createElement('div', 'xs-modal');
            const header = _createElement('div', 'xs-modal-header');
            const body = _createElement('div', 'xs-modal-body');
            const closeBtn = _createElement('button', 'xs-modal-close', '×');
            
            header.appendChild(_createElement('h3', 'xs-modal-title', title));
            header.appendChild(closeBtn);
            body.innerHTML = content;
            
            modal.appendChild(header);
            modal.appendChild(body);
            
            if (footer) {
                const footerEl = _createElement('div', 'xs-modal-footer');
                footerEl.innerHTML = footer;
                modal.appendChild(footerEl);
            }
            
            return modal;
        },
        
        // 显示组件
        showComponent: function(component, options = {}) {
            return new Promise((resolve) => {
                const overlay = this.createOverlay();
                overlay.appendChild(component);
                
                // 点击遮罩层关闭
                if (options.closeOnOverlayClick !== false) {
                    overlay.addEventListener('click', function(e) {
                        if (e.target === this) {
                            XSComponent.hideComponent(overlay);
                            resolve(false);
                        }
                    });
                }
                
                // 关闭按钮事件
                const closeBtn = component.querySelector('.xs-modal-close');
                if (closeBtn) {
                    closeBtn.addEventListener('click', function() {
                        XSComponent.hideComponent(overlay);
                        resolve(false);
                    });
                }
                
                // 显示组件
                setTimeout(() => {
                    overlay.classList.add('active');
                }, 10);
                
                // 保存引用以便后续操作
                overlay._component = component;
                overlay._resolve = resolve;
            });
        },
        
        // 隐藏组件
        hideComponent: function(overlay) {
            overlay.classList.remove('active');
            setTimeout(() => {
                _removeFromBody(overlay);
            }, 300);
        }
    };
    
    // Alert组件
    window.XSAlert = function(message, title = '提示') {
        const content = `<p>${message}</p>`;
        const footer = `<button class="xs-button" id="xs-alert-confirm">确定</button>`;
        const modal = XSComponent.createModal(title, content, footer);
        const confirmBtn = modal.querySelector('#xs-alert-confirm');
        confirmBtn.addEventListener('click', function() {
            console.log("confirmBtn.addEventListener");
            const overlay = modal.closest('.xs-overlay');
            XSComponent.hideComponent(overlay);
        });
        return XSComponent.showComponent(modal);
    };
    
    // Confirm组件
    window.XSConfirm = function(message, title = '请确认') {
        return new Promise((resolve) => {
            const content = `<p>${message}</p>`;
            const footer = `
                <button class="xs-button xs-secondary" id="xs-confirm-cancel">取消</button>
                <button class="xs-button" id="xs-confirm-ok">确定</button>
            `;
            const modal = XSComponent.createModal(title, content, footer);

            XSComponent.showComponent(modal).then((result) => {
                resolve(result);
            });

            // 添加按钮事件
            const cancelBtn = modal.querySelector('#xs-confirm-cancel');
            const okBtn = modal.querySelector('#xs-confirm-ok');
            const overlay = modal.closest('.xs-overlay');

            cancelBtn.addEventListener('click', function() {
                overlay._resolve(false);
                XSComponent.hideComponent(overlay);
            });

            okBtn.addEventListener('click', function() {
                overlay._resolve(true);
                XSComponent.hideComponent(overlay);
            });
        });
    };
    
    // Modal组件
    window.XSModal = function(options = {}) {
        const { title = '', content = '', showClose = true, buttons = [] } = options;
        const modal = XSComponent.createModal(title, content);
        
        if (!showClose) {
            const closeBtn = modal.querySelector('.xs-modal-close');
            if (closeBtn) closeBtn.style.display = 'none';
        }
        
        // 添加自定义按钮
        if (buttons.length > 0) {
            const footer = _createElement('div', 'xs-modal-footer');
            buttons.forEach(btn => {
                const button = _createElement('button', `xs-button ${btn.class || ''}`, btn.text);
                button.addEventListener('click', btn.handler);
                footer.appendChild(button);
            });
            modal.appendChild(footer);
        }
        
        return XSComponent.showComponent(modal, { closeOnOverlayClick: false });
    };
    
    // Toast组件
    window.XSToast = function(message, duration = 3000) {
        const toast = _createElement('div', 'xs-toast', message);
        _appendToBody(toast);
        
        // 显示toast
        setTimeout(() => {
            toast.classList.add('active');
        }, 10);
        
        // 自动隐藏
        setTimeout(() => {
            toast.classList.remove('active');
            setTimeout(() => {
                _removeFromBody(toast);
            }, 400);
        }, duration);
    };
    
    // Loading组件
    window.XSLoading = {
        show: function(text = '加载中...') {
            // 如果已存在，先隐藏
            this.hide();
            
            const overlay = XSComponent.createOverlay();
            overlay.style.background = 'rgba(255, 255, 255, 0.9)';
            overlay.style.zIndex = '10002';
            
            const loadingContainer = _createElement('div', 'xs-loading-container');
            const spinner = _createElement('div', 'xs-loading');
            const loadingText = _createElement('div', 'xs-loading-text', text);
            
            loadingContainer.appendChild(spinner);
            loadingContainer.appendChild(loadingText);
            overlay.appendChild(loadingContainer);
            
            // 显示loading
            setTimeout(() => {
                overlay.classList.add('active');
            }, 10);
            
            // 保存引用
            this._overlay = overlay;
        },
        
        hide: function() {
            if (this._overlay) {
                XSComponent.hideComponent(this._overlay);
                this._overlay = null;
            }
        },
        
        setText: function(text) {
            if (this._overlay) {
                const textEl = this._overlay.querySelector('.xs-loading-text');
                if (textEl) {
                    textEl.textContent = text;
                }
            }
        }
    };
    
    // 初始化组件
    document.addEventListener('DOMContentLoaded', function() {
        // 添加基础样式重置
        const styleReset = _createElement('style');
        styleReset.textContent = `
            .xs-component-reset button {
                border: none;
                outline: none;
                font-family: inherit;
            }
            
            .xs-component-reset button:focus {
                outline: none;
            }
        `;
        document.head.appendChild(styleReset);
        
        // 添加组件重置类到body
        document.body.classList.add('xs-component-reset');
    });
})();