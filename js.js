<script>
    (function(){
const inputID = "input_179_28";
const __on = function (el, eventName, eventHandler, selector) {
  if (selector) {
    const wrappedHandler = (e) => {
      if (!e.target) return;
      const el = e.target.closest(selector);
      if (el) {
        eventHandler.call(el, e);
      }
    };
    el.addEventListener(eventName, wrappedHandler);
    return wrappedHandler;
  } else {
    const wrappedHandler = (e) => {
      eventHandler.call(el, e);
    };
    el.addEventListener(eventName, wrappedHandler);
    return wrappedHandler;
  }
};

__on(
  document,
  "change",
  function () {
    const is_checked = this.checked;
    const value = this.value;
    if (is_checked) {
      document
        .querySelectorAll(`#${inputID} .gfield-choice-input`)
        .forEach((input) => {
          if (input.value != value) {
            input.checked = false;
            console.log(input.closest('.image-choices-choice'));
            if(input.closest('.image-choices-choice') !== null) {
                input.closest('.image-choices-choice').classList.remove('image-choices-choice-selected');
            }
          }
        });
    }
    // console.log(this.checked);
  },
  `#${inputID} .gfield-choice-input`,
);
    })();

</script>