/**
 * Pure DOM launcher for the main-page magic wand menu (`#extensionsMenu`).
 * SillyTavern renders that menu as children of `#extensionsMenu`; the wand
 * button itself is `#extensionsMenuButton` and stays owned by the host.
 */
export const WAND_CONTAINER_ID = 'worldbook_switch_manager_wand_container';
export const WAND_BUTTON_ID = 'worldbook_switch_manager_wand_button';

export function createLauncher(menu, onOpen) {
    if (!menu || typeof onOpen !== 'function') return null;

    // A previous instance may survive an abnormal reload of the extension.
    menu.querySelector(`#${WAND_CONTAINER_ID}`)?.remove();

    const container = document.createElement('div');
    container.id = WAND_CONTAINER_ID;
    container.className = 'extension_container';

    const button = document.createElement('div');
    button.id = WAND_BUTTON_ID;
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.title = '世界书自动开关管理器';

    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-book-atlas extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = '世界书自动开关管理器';
    button.append(icon, label);

    const activate = () => onOpen();
    const onKeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
    };
    button.addEventListener('click', activate);
    button.addEventListener('keydown', onKeydown);

    container.append(button);
    menu.append(container);

    return {
        container,
        button,
        destroy() {
            button.removeEventListener('click', activate);
            button.removeEventListener('keydown', onKeydown);
            container.remove();
        },
    };
}
