/* Display-only GPU remapping. Detection and metric poses use original pixels. */
class TrackingPreview {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw Error('Undistorted live preview needs WebGL support.');
    const shader = (type, text) => {
      const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = this.program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `
      attribute vec2 position; varying vec2 uv;
      void main(){ gl_Position=vec4(position,0.,1.); uv=vec2((position.x+1.)*.5,(1.-position.y)*.5); }
    `));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec2 uv;
      uniform sampler2D videoTexture, overlayTexture;
      uniform vec2 imageSize;
      uniform vec4 intrinsics, outputIntrinsics, distortion;
      uniform bool fisheye;
      void main(){
        vec2 p=uv*imageSize-vec2(.5);
        vec2 n=(p-outputIntrinsics.zw)/outputIntrinsics.xy;
        float r2=dot(n,n); vec2 d;
        if(fisheye){
          float r=sqrt(r2), theta=atan(r), t2=theta*theta;
          float td=theta*(1.+t2*(distortion.x+t2*(distortion.y+t2*(distortion.z+t2*distortion.w))));
          d=n*(r>1e-8 ? td/r : 1.);
        } else {
          float radial=1.+distortion.x*r2+distortion.y*r2*r2;
          d=n*radial+vec2(2.*distortion.z*n.x*n.y+distortion.w*(r2+2.*n.x*n.x),
                           distortion.z*(r2+2.*n.y*n.y)+2.*distortion.w*n.x*n.y);
        }
        vec2 source=(d*intrinsics.xy+intrinsics.zw+vec2(.5))/imageSize;
        vec2 sourcePixel=source*imageSize-vec2(.5);
        vec2 edge=clamp(min(sourcePixel+vec2(1.),imageSize-sourcePixel),vec2(0.),vec2(1.));
        float coverage=edge.x*edge.y;
        vec4 color=texture2D(videoTexture,source), axes=texture2D(overlayTexture,source);
        gl_FragColor=vec4(mix(color.rgb,axes.rgb,axes.a)*coverage,1.);
      }
    `));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    this.textures = [0,1].map((unit) => {
      const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
    gl.uniform1i(gl.getUniformLocation(program, 'videoTexture'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'overlayTexture'), 1);
  }
  draw(video, overlay, geometry) {
    const {gl, program, canvas} = this;
    const [width, height] = geometry.size;
    if (canvas.width !== width || canvas.height !== height) { canvas.width=width; canvas.height=height; }
    gl.viewport(0,0,width,height); gl.useProgram(program);
    const intrinsic = K => [K[0][0],K[1][1],K[0][2],K[1][2]];
    gl.uniform2f(gl.getUniformLocation(program,'imageSize'),width,height);
    gl.uniform4fv(gl.getUniformLocation(program,'intrinsics'),intrinsic(geometry.K));
    gl.uniform4fv(gl.getUniformLocation(program,'outputIntrinsics'),intrinsic(geometry.newK));
    gl.uniform4fv(gl.getUniformLocation(program,'distortion'),geometry.D.slice(0,4));
    gl.uniform1i(gl.getUniformLocation(program,'fisheye'),geometry.model==='fisheye');
    [video,overlay].forEach((source,i)=>{
      gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.textures[i]);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    });
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
}
